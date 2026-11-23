/**
 * desktop-hands.js — Masaüstü webcam el takibi (MediaPipe Hand Landmarker).
 *
 *  - MediaPipe yalnızca "Start Camera" ile ve kullanıcı onayı sonrasında,
 *    dinamik import ile yüklenir (Quest'te VR için gereksiz indirme yapılmaz).
 *  - Jestler için worldLandmarks (metre cinsinden, elin merkezine göre 3B)
 *    kullanılır; yoksa görüntü landmark'ları en-boy oranı düzeltilerek kullanılır.
 *  - Çıktı formatı gestures.js ile ortaktır.
 */

const TASKS_VERSION = '0.10.14';
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/** MediaPipe landmark indeksleri → ortak format */
export const MP_LANDMARKS = Object.freeze({
  wrist: 0,
  thumbTip: 4,
  indexTip: 8,
  middleMcp: 9,
  middleTip: 12,
  ringTip: 16,
  pinkyTip: 20,
});

const FINGER_TIP_INDEX = { index: 8, ring: 16, pinky: 20 };
const GESTURE_FINGER = { forward: 'index', 'rotate-right': 'pinky', 'rotate-left': 'ring' };

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

/**
 * MediaPipe sonucunu ortak gesture formatına çevirir (test edilebilir saf fonksiyon).
 * @param {object} result HandLandmarkerResult
 * @param {number} aspect video genişlik/yükseklik oranı
 */
export function mediapipeToHands(result, aspect = 1) {
  const hands = [];
  if (!result || !result.landmarks) return hands;
  const handednessList = result.handedness ?? result.handednesses ?? [];
  const used = new Set();
  for (let i = 0; i < result.landmarks.length; i++) {
    const world = result.worldLandmarks?.[i];
    const img = result.landmarks[i];
    const src = world && world.length === 21 ? world : img;
    if (!src || src.length !== 21) continue;
    const useAspect = src === img;

    // MediaPipe el etiketini "aynalı (selfie) görüntü" varsayımıyla verir.
    // getUserMedia karesi aynalanmadığı için etiketi çeviriyoruz.
    const label = handednessList[i]?.[0]?.categoryName?.toLowerCase();
    let handedness = label === 'left' ? 'right' : label === 'right' ? 'left' : 'unknown';
    let id = handedness;
    if (used.has(id)) id = `${handedness}-${i}`;
    used.add(id);

    const points = {};
    for (const [key, idx] of Object.entries(MP_LANDMARKS)) {
      const p = src[idx];
      points[key] = useAspect
        ? { x: p.x * aspect, y: p.y, z: (p.z ?? 0) * aspect }
        : { x: p.x, y: p.y, z: p.z ?? 0 };
    }
    hands.push({ id, handedness, points, imageLandmarks: img });
  }
  return hands;
}

export class DesktopHandTracker {
  /**
   * @param {{video:HTMLVideoElement, canvas:HTMLCanvasElement}} els
   */
  constructor({ video, canvas }) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.stream = null;
    this.landmarker = null;
    this.running = false;
    this.starting = false;
    this.status = 'Kapalı';
    this.lastVideoTime = -1;
    this.lastResult = null;
    this.hands = [];
    this._onTrackEnded = () => {
      this.stop();
      this.status = 'Kamera bağlantısı kesildi';
      this.onError?.(new Error('Kamera akışı sonlandı.'));
    };
    /** @type {(err:Error)=>void | undefined} */
    this.onError = undefined;
  }

  async _createLandmarker() {
    const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      return await HandLandmarker.createFromOptions(vision, opts('GPU'));
    } catch (gpuErr) {
      console.warn('[desktop-hands] GPU delegate başarısız, CPU deneniyor:', gpuErr);
      return HandLandmarker.createFromOptions(vision, opts('CPU'));
    }
  }

  /** Kullanıcı onayını aldıktan SONRA çağrılmalı. */
  async start() {
    if (this.running || this.starting) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Bu tarayıcı kamera erişimini (getUserMedia) desteklemiyor.');
    }
    this.starting = true;
    this.status = 'Kamera izni bekleniyor…';
    try {
      const streamPromise = navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      const landmarkerPromise = this.landmarker ? Promise.resolve(this.landmarker) : this._createLandmarker();

      try {
        this.stream = await streamPromise;
      } catch (err) {
        landmarkerPromise.catch(() => {}); // yarım kalan yüklemeyi sessize al
        throw new Error(DesktopHandTracker.describeCameraError(err));
      }
      this.status = 'Model yükleniyor…';
      try {
        this.landmarker = await landmarkerPromise;
      } catch (err) {
        throw new Error(`MediaPipe yüklenemedi: ${err.message}`);
      }

      this.video.srcObject = this.stream;
      this.stream.getVideoTracks()[0]?.addEventListener('ended', this._onTrackEnded);
      await this.video.play();
      this.canvas.width = this.video.videoWidth || 640;
      this.canvas.height = this.video.videoHeight || 480;
      this.lastVideoTime = -1;
      this.running = true;
      this.status = 'Çalışıyor';
    } catch (err) {
      this._releaseStream();
      this.status = 'Hata';
      throw err;
    } finally {
      this.starting = false;
    }
  }

  static describeCameraError(err) {
    switch (err?.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Kamera izni reddedildi. Tarayıcının adres çubuğundaki kamera simgesinden izni açabilirsiniz.';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'Kullanılabilir bir kamera bulunamadı.';
      case 'NotReadableError':
        return 'Kamera başka bir uygulama tarafından kullanılıyor olabilir.';
      default:
        return `Kamera başlatılamadı: ${err?.message ?? err}`;
    }
  }

  _releaseStream() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        t.removeEventListener('ended', this._onTrackEnded);
        t.stop();
      }
    }
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
  }

  stop() {
    this.running = false;
    this._releaseStream();
    this.hands = [];
    this.lastResult = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.status = 'Kapalı';
  }

  /** Tamamen serbest bırak (sayfa kapanırken). */
  dispose() {
    this.stop();
    try { this.landmarker?.close(); } catch { /* yok say */ }
    this.landmarker = null;
  }

  /**
   * Yeni video karesi varsa algılama çalıştırır.
   * @returns {Array} ortak formatta eller (yeni kare yoksa son sonuç)
   */
  update(nowMs) {
    if (!this.running || !this.landmarker) return [];
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      try {
        this.lastResult = this.landmarker.detectForVideo(v, nowMs);
        const aspect = (v.videoWidth || 4) / (v.videoHeight || 3);
        this.hands = mediapipeToHands(this.lastResult, aspect);
      } catch (err) {
        console.warn('[desktop-hands] detectForVideo hatası:', err);
        this.hands = [];
      }
    }
    return this.hands;
  }

  /**
   * Landmark'ları video üzerine çizer. Aktif pinch, başparmak ile ilgili parmak
   * arasında kalın bir çizgiyle gösterilir.
   * @param {Array<{id:string, gesture:string, pressed:object}>} perHand
   */
  draw(perHand = []) {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.running) return;
    const W = canvas.width;
    const H = canvas.height;
    const byId = new Map(perHand.map((h) => [h.id, h]));

    for (const hand of this.hands) {
      const lm = hand.imageLandmarks;
      if (!lm) continue;
      const g = byId.get(hand.id);
      const color = hand.handedness === 'left' ? '#4fd1c5' : '#f6ad55';

      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (const [a, b] of CONNECTIONS) {
        ctx.moveTo(lm[a].x * W, lm[a].y * H);
        ctx.lineTo(lm[b].x * W, lm[b].y * H);
      }
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      for (const p of lm) {
        ctx.beginPath();
        ctx.arc(p.x * W, p.y * H, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Basılı parmaklar (hysteresis durumu)
      if (g?.pressed) {
        for (const [finger, idx] of Object.entries(FINGER_TIP_INDEX)) {
          if (!g.pressed[finger]) continue;
          const isActive = GESTURE_FINGER[g.gesture] === finger;
          ctx.strokeStyle = isActive ? '#48bb78' : 'rgba(255,255,255,0.5)';
          ctx.lineWidth = isActive ? 6 : 2;
          ctx.beginPath();
          ctx.moveTo(lm[4].x * W, lm[4].y * H);
          ctx.lineTo(lm[idx].x * W, lm[idx].y * H);
          ctx.stroke();
        }
      }
    }
  }
}
