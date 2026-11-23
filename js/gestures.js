/**
 * gestures.js — Ortak jest motoru (gesture engine)
 *
 * Bu modül hiçbir harici bağımlılık içermez (Three.js veya MediaPipe yok).
 * Hem WebXR (Quest 3 native hand tracking) hem de masaüstü (MediaPipe Hand
 * Landmarker) verisi buraya AYNI formatta gelir:
 *
 *   {
 *     id: 'left' | 'right' | string,      // el kimliği (state takibi için)
 *     handedness: 'left' | 'right' | 'unknown',
 *     points: {
 *       wrist, thumbTip, indexTip, middleTip, ringTip, pinkyTip, middleMcp
 *     }                                   // her biri {x, y, z}
 *   }
 *
 * Koordinat birimi önemli değildir; tüm mesafeler el büyüklüğüne
 * (bilek → orta parmak MCP eklemi) bölünerek normalize edilir. Bu sayede
 * WebXR metre verisi ile MediaPipe world-landmark verisi aynı eşiklerle çalışır
 * ve büyük/küçük eller aynı davranışı verir.
 */

export const Gesture = Object.freeze({
  NONE: 'none',
  FORWARD: 'forward',
  ROTATE_RIGHT: 'rotate-right',
  ROTATE_LEFT: 'rotate-left',
});

/** Hangi parmak (başparmakla pinch yapıldığında) hangi jesti tetikler. */
export const FINGER_GESTURE = Object.freeze({
  index: Gesture.FORWARD,
  pinky: Gesture.ROTATE_RIGHT,
  ring: Gesture.ROTATE_LEFT,
});

/** Jest → okunabilir Türkçe etiket (UI için). */
export const GESTURE_LABEL = Object.freeze({
  [Gesture.NONE]: 'Yok',
  [Gesture.FORWARD]: 'İleri (başparmak + işaret)',
  [Gesture.ROTATE_RIGHT]: 'Sağa dönüş (başparmak + serçe)',
  [Gesture.ROTATE_LEFT]: 'Sola dönüş (başparmak + yüzük)',
});

export const REQUIRED_POINTS = Object.freeze([
  'wrist', 'thumbTip', 'indexTip', 'middleTip', 'ringTip', 'pinkyTip', 'middleMcp',
]);

/**
 * Varsayılan ayarlar. Eşikler normalize mesafedir:
 *   d = |başparmakUcu − parmakUcu| / |bilek − ortaParmakMCP|
 * Yetişkin elinde bilek→MCP ≈ 9–10 cm olduğundan press 0.25 ≈ 2.4 cm'ye denk gelir.
 * press < release olmalıdır (hysteresis).
 */
export const DEFAULT_CONFIG = Object.freeze({
  thresholds: {
    index: { press: 0.25, release: 0.38 },
    ring: { press: 0.30, release: 0.44 },
    pinky: { press: 0.30, release: 0.44 },
  },
  /** İki aktif pinch arasındaki fark bu değerden küçükse "belirsiz" kabul edilir. */
  ambiguityMargin: 0.06,
  /**
   * Orta parmak koruması: başparmak–orta parmak mesafesi, seçilecek adaydan
   * bu kadar daha küçükse kullanıcı aslında orta parmakla pinch yapıyordur;
   * yanlış jest seçilmez.
   */
  middleGuardMargin: 0.05,
  /** Belirsizlikte kullanılacak öncelik sırası (soldaki en yüksek). */
  priority: [Gesture.FORWARD, Gesture.ROTATE_RIGHT, Gesture.ROTATE_LEFT],
  /** İki el aynı anda: biri yürürken diğeri döndürebilir mi? */
  allowWalkAndTurn: true,
  /** El büyüklüğü bu değerin altındaysa veri geçersiz sayılır (birimden bağımsız güvenlik). */
  minHandSize: 1e-6,
});

// ---------------------------------------------------------------------------
// Matematik yardımcıları
// ---------------------------------------------------------------------------

export function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function isFinitePoint(p) {
  return p != null && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z ?? 0);
}

/** Tüm gerekli noktalar mevcut ve sayısal mı? */
export function isValidHand(points) {
  if (!points) return false;
  for (const k of REQUIRED_POINTS) {
    if (!isFinitePoint(points[k])) return false;
  }
  return true;
}

/** El büyüklüğü: bilek → orta parmak MCP (metakarpofalangeal) eklemi. */
export function handSize(points) {
  return distance(points.wrist, points.middleMcp);
}

/**
 * Başparmak ucundan diğer parmak uçlarına olan normalize mesafeler.
 * @returns {{size:number, index:number, middle:number, ring:number, pinky:number} | null}
 */
export function normalizedPinchDistances(points, minHandSize = DEFAULT_CONFIG.minHandSize) {
  if (!isValidHand(points)) return null;
  const size = handSize(points);
  if (!(size > minHandSize)) return null;
  const t = points.thumbTip;
  return {
    size,
    index: distance(t, points.indexTip) / size,
    middle: distance(t, points.middleTip) / size,
    ring: distance(t, points.ringTip) / size,
    pinky: distance(t, points.pinkyTip) / size,
  };
}

function mergeConfig(user = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...user,
    thresholds: {
      index: { ...DEFAULT_CONFIG.thresholds.index, ...(user.thresholds?.index ?? {}) },
      ring: { ...DEFAULT_CONFIG.thresholds.ring, ...(user.thresholds?.ring ?? {}) },
      pinky: { ...DEFAULT_CONFIG.thresholds.pinky, ...(user.thresholds?.pinky ?? {}) },
    },
    priority: user.priority ? [...user.priority] : [...DEFAULT_CONFIG.priority],
  };
}

// ---------------------------------------------------------------------------
// Tek el durum makinesi
// ---------------------------------------------------------------------------

const PINCH_FINGERS = ['index', 'ring', 'pinky'];

/**
 * Tek bir elin jest durumunu tutar.
 *  1. Her parmak için hysteresis: d < press → basılı; d > release → bırakıldı.
 *  2. Kilitleme (latch): bir jest seçildiğinde, o parmak bırakılana kadar jest
 *     değişmez. Böylece yüzük pinch'i sırasında serçe parmağı da yaklaşsa
 *     dönüş yönü aniden değişmez.
 *  3. Yeni seçim: basılı parmaklar mesafeye göre sıralanır; en yakın ikisi
 *     ambiguityMargin içindeyse öncelik sırası uygulanır. Belirsizlik yalnızca
 *     zıt iki dönüş arasındaysa hiçbir hareket seçilmez.
 *  4. Orta parmak koruması.
 */
export class HandGestureState {
  constructor(config = {}) {
    this.config = mergeConfig(config);
    this.reset();
  }

  reset() {
    this.pressed = { index: false, ring: false, pinky: false };
    this.gesture = Gesture.NONE;
    this.lockedFinger = null;
    this.distances = null;
    this.ambiguous = false;
  }

  /**
   * @param {object|null} points
   * @returns {{gesture:string, distances:object|null, pressed:object, ambiguous:boolean, valid:boolean}}
   */
  update(points) {
    const d = normalizedPinchDistances(points, this.config.minHandSize);
    if (!d) {
      this.reset();
      return this.snapshot(false);
    }
    this.distances = d;
    this.ambiguous = false;

    // 1) Hysteresis
    for (const f of PINCH_FINGERS) {
      const th = this.config.thresholds[f];
      if (this.pressed[f]) {
        if (d[f] > th.release) this.pressed[f] = false;
      } else if (d[f] < th.press) {
        this.pressed[f] = true;
      }
    }

    // 2) Kilitli jest hâlâ basılı mı?
    if (this.lockedFinger && this.pressed[this.lockedFinger]) {
      this.gesture = FINGER_GESTURE[this.lockedFinger];
      return this.snapshot(true);
    }
    this.lockedFinger = null;
    this.gesture = Gesture.NONE;

    // 3) Yeni seçim
    const candidates = PINCH_FINGERS.filter((f) => this.pressed[f]).sort((a, b) => d[a] - d[b]);
    if (candidates.length === 0) return this.snapshot(true);

    let chosen = candidates[0];
    if (candidates.length > 1) {
      const near = candidates.filter((f) => d[f] - d[candidates[0]] <= this.config.ambiguityMargin);
      if (near.length > 1) {
        this.ambiguous = true;
        const gestures = near.map((f) => FINGER_GESTURE[f]);
        const hasForward = gestures.includes(Gesture.FORWARD);
        const opposingTurns = gestures.includes(Gesture.ROTATE_LEFT) && gestures.includes(Gesture.ROTATE_RIGHT);
        if (opposingTurns && !hasForward) {
          // Sağ mı sol mu belli değil → yanlış yöne dönmektense dur.
          return this.snapshot(true);
        }
        const rank = (f) => {
          const i = this.config.priority.indexOf(FINGER_GESTURE[f]);
          return i === -1 ? Infinity : i;
        };
        chosen = [...near].sort((a, b) => rank(a) - rank(b))[0];
      }
    }

    // 4) Orta parmak koruması
    if (d.middle < d[chosen] - this.config.middleGuardMargin) {
      return this.snapshot(true);
    }

    this.lockedFinger = chosen;
    this.gesture = FINGER_GESTURE[chosen];
    return this.snapshot(true);
  }

  snapshot(valid) {
    return {
      gesture: this.gesture,
      distances: this.distances,
      pressed: { ...this.pressed },
      ambiguous: this.ambiguous,
      valid,
    };
  }
}

// ---------------------------------------------------------------------------
// Çok elli motor
// ---------------------------------------------------------------------------

/**
 * Birden fazla eli (VR'da iki el, masaüstünde MediaPipe'ın bulduğu eller)
 * birleştirip tek bir hareket niyeti (intent) üretir.
 *
 * Çıktı:
 *   forward  : boolean       — ileri yürü
 *   rotation : -1 | 0 | 1    — +1 sağa, −1 sola
 *   conflict : boolean       — eller zıt dönüş istedi → rotation 0
 *   perHand  : [{id, handedness, gesture, distances, ambiguous}]
 *   handCount: takip edilen geçerli el sayısı
 */
export class GestureEngine {
  constructor(config = {}) {
    this.config = mergeConfig(config);
    /** @type {Map<string, HandGestureState>} */
    this.states = new Map();
    this.last = GestureEngine.emptyResult();
  }

  static emptyResult() {
    return { forward: false, rotation: 0, conflict: false, perHand: [], handCount: 0 };
  }

  reset() {
    this.states.clear();
    this.last = GestureEngine.emptyResult();
  }

  /**
   * @param {Array<{id?:string, handedness?:string, points:object}>} hands
   */
  update(hands = []) {
    const seen = new Set();
    const perHand = [];

    for (let i = 0; i < hands.length; i++) {
      const h = hands[i];
      if (!h) continue;
      const id = h.id ?? h.handedness ?? `hand-${i}`;
      seen.add(id);
      let state = this.states.get(id);
      if (!state) {
        state = new HandGestureState(this.config);
        this.states.set(id, state);
      }
      const r = state.update(h.points);
      if (!r.valid) continue;
      perHand.push({
        id,
        handedness: h.handedness ?? 'unknown',
        gesture: r.gesture,
        distances: r.distances,
        ambiguous: r.ambiguous,
        pressed: r.pressed,
      });
    }

    // Görünmeyen ellerin durumunu sil → el tekrar girdiğinde temiz başlar.
    for (const id of [...this.states.keys()]) {
      if (!seen.has(id)) this.states.delete(id);
    }

    let forward = false;
    let right = false;
    let left = false;
    for (const h of perHand) {
      if (h.gesture === Gesture.FORWARD) forward = true;
      else if (h.gesture === Gesture.ROTATE_RIGHT) right = true;
      else if (h.gesture === Gesture.ROTATE_LEFT) left = true;
    }

    const conflict = right && left;
    let rotation = conflict ? 0 : right ? 1 : left ? -1 : 0;
    if (forward && !this.config.allowWalkAndTurn) rotation = 0; // öncelik: ileri

    this.last = { forward, rotation, conflict, perHand, handCount: perHand.length };
    return this.last;
  }
}
