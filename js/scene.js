/**
 * scene.js — 1:70 ölçek sistemi, örnek mimari maket ve GLB/GLTF yükleyici.
 *
 * DÖRT AYRI KAVRAM (README'de ayrıntılı):
 *  1) Gerçek bina ölçüsü (tasarım metresi)        örn. duvar 3.00 m
 *  2) Maket ölçüsü = gerçek / 70 ("model birimi")  örn. duvar 0.0429 m
 *  3) Tracking space (WebXR, daima gerçek metre)   baş/el pozları
 *  4) Görüntü ölçeği (viewScale): maket kökünü dünyaya yerleştiren çarpan
 *
 * İnsan perspektifi için maket kökü 70 kat büyütülür (viewScale = 70).
 * Kamera/baş pozuna HİÇBİR ölçek uygulanmaz; 1 m fiziksel baş hareketi
 * maket içinde 1/70 m = 1.43 cm'ye, yani gerçek binada 1 m'ye karşılık gelir.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const SCALE = Object.freeze({
  /** Maket ölçeği paydası (1:70) */
  denominator: 70,
  /** Ölçek oranı (maket / gerçek) */
  ratio: 1 / 70,
  /** Referans insan boyu (m, gerçek) */
  humanHeight: 1.7,
  /** Referans göz yüksekliği (m, gerçek) — yalnızca masaüstü kamerası ve referans figür için */
  eyeHeight: 1.6,
  /** Ölçeklenmiş göz yüksekliği (maket birimi) = 1.60 / 70 ≈ 0.02286 */
  get scaledEyeHeight() { return this.eyeHeight / this.denominator; },
});

/** Gerçek metre → maket birimi */
export const toModel = (realMeters) => realMeters / SCALE.denominator;

export const VIEW_MODES = Object.freeze({
  human: {
    id: 'human',
    label: 'İnsan perspektifi',
    viewScale: SCALE.denominator, // maket ×70 → gerçek boyut algısı
  },
  maquette: {
    id: 'maquette',
    label: 'Maket görünümü',
    viewScale: 1, // maketi masadaki fiziksel boyutuyla gör
  },
});

/**
 * Maket kökünü (modelRoot) yönetir. Tüm mimari içerik bu kökün altında,
 * MAKET BİRİMİNDE durur. Ölçek değişimi yalnızca bu kökün scale değerini
 * değiştirir; rig/kamera/el verisine dokunmaz.
 */
export class ScaleSystem {
  constructor(scene) {
    this.modelRoot = new THREE.Group();
    this.modelRoot.name = 'modelRoot (maket birimi)';
    scene.add(this.modelRoot);
    this.mode = VIEW_MODES.human;
    this.apply();
  }

  get viewScale() { return this.mode.viewScale; }

  apply() {
    this.modelRoot.scale.setScalar(this.mode.viewScale);
    this.modelRoot.updateMatrixWorld(true);
  }

  /**
   * Görünüm modunu değiştirir ve rig'i maket içindeki AYNI noktada tutar.
   * Maket kökü dünya orijininde olduğundan: p_world = p_model × viewScale.
   */
  setMode(modeId, rig) {
    const next = VIEW_MODES[modeId];
    if (!next || next === this.mode) return;
    const k = next.viewScale / this.mode.viewScale;
    if (rig) {
      rig.position.x *= k;
      rig.position.z *= k; // y (zemin) 0'da kalır; baş yüksekliği tracking'den gelir
      rig.updateMatrixWorld();
    }
    this.mode = next;
    this.apply();
  }

  /** Dünya uzayındaki bir noktanın maket birimindeki karşılığı. */
  worldToModel(v, target = new THREE.Vector3()) {
    return target.copy(v).divideScalar(this.viewScale);
  }

  /** Dünya uzayındaki bir noktanın gerçek bina metresindeki karşılığı. */
  worldToReal(v, target = new THREE.Vector3()) {
    return this.worldToModel(v, target).multiplyScalar(SCALE.denominator);
  }

  get label() {
    return `1:${SCALE.denominator} · ${this.mode.label} (maket ×${this.mode.viewScale})`;
  }
}

// ---------------------------------------------------------------------------
// Örnek mimari maket (tek draw call'a birleştirilmiş, vertex color)
// ---------------------------------------------------------------------------

const COLORS = {
  ground: 0x5b6b4f,
  floor: 0xd9d4c7,
  wall: 0xf1efe9,
  wallOuter: 0xe4e0d6,
  frame: 0x3b3f46,
  door: 0x9c6b3f,
  box1: 0xc96f53,
  box2: 0x5f8fb4,
  box3: 0x7aa05b,
  box4: 0xd6b04a,
  box5: 0x8d6fb8,
  human: 0x2d3748,
  arrow: 0x2b6cb0,
  arrowRight: 0xdd6b20,
  arrowLeft: 0x38a169,
  rulerA: 0x111111,
  rulerB: 0xfafafa,
};

/**
 * Geometrileri renk gruplarıyla toplar; sonunda tek BufferGeometry'e birleştirir.
 * Tüm ölçüler GERÇEK metre olarak verilir ve toModel() ile maket birimine çevrilir.
 */
class GeometryBatch {
  constructor() {
    this.parts = [];
    this._color = new THREE.Color();
  }

  _push(geo, color) {
    const g = geo; // tüm üretilen geometriler indekslidir (mergeGeometries için şart)
    const count = g.attributes.position.count;
    const c = this._color.setHex(color);
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    this.parts.push(g);
  }

  /** Eksen hizalı kutu: merkez XZ ve taban yüksekliği y0, gerçek metre. */
  box(cx, cz, w, d, h, color, y0 = 0, rotY = 0) {
    const geo = new THREE.BoxGeometry(toModel(w), toModel(h), toModel(d));
    if (rotY) geo.rotateY(rotY);
    geo.translate(toModel(cx), toModel(y0 + h / 2), toModel(cz));
    this._push(geo, color);
  }

  /** Zemine yatık düz şekil (ok vb.) */
  flatShape(shape, cx, cz, rotY, color, y = 0.01) {
    const geo = new THREE.ShapeGeometry(shape);
    geo.scale(toModel(1), toModel(1), toModel(1));
    geo.rotateX(-Math.PI / 2);
    geo.rotateY(rotY);
    geo.translate(toModel(cx), toModel(y), toModel(cz));
    this._push(geo, color);
  }

  cylinder(cx, cz, r, h, color, y0 = 0, seg = 10) {
    const geo = new THREE.CylinderGeometry(toModel(r), toModel(r), toModel(h), seg);
    geo.translate(toModel(cx), toModel(y0 + h / 2), toModel(cz));
    this._push(geo, color);
  }

  sphere(cx, cy, cz, r, color) {
    const geo = new THREE.SphereGeometry(toModel(r), 10, 8);
    geo.translate(toModel(cx), toModel(cy), toModel(cz));
    this._push(geo, color);
  }

  build(material) {
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    merged.computeBoundingSphere();
    return new THREE.Mesh(merged, material);
  }
}

/** X ekseni boyunca duvar; doors: [[x0,x1], …] kapı boşlukları */
function wallAlongX(batch, z, x0, x1, doors, H, T, color, frames) {
  const segs = [];
  let cur = x0;
  for (const [a, b] of [...doors].sort((p, q) => p[0] - q[0])) {
    if (a > cur) segs.push([cur, a]);
    cur = b;
    frames.push({ axis: 'x', c: (a + b) / 2, fixed: z, w: b - a });
  }
  if (cur < x1) segs.push([cur, x1]);
  for (const [a, b] of segs) batch.box((a + b) / 2, z, b - a, T, H, color);
  for (const [a, b] of doors) batch.box((a + b) / 2, z, b - a, T, H - DOOR_H, color, DOOR_H); // lento
}

/** Z ekseni boyunca duvar */
function wallAlongZ(batch, x, z0, z1, doors, H, T, color, frames) {
  const segs = [];
  let cur = z0;
  for (const [a, b] of [...doors].sort((p, q) => p[0] - q[0])) {
    if (a > cur) segs.push([cur, a]);
    cur = b;
    frames.push({ axis: 'z', c: (a + b) / 2, fixed: x, w: b - a });
  }
  if (cur < z1) segs.push([cur, z1]);
  for (const [a, b] of segs) batch.box(x, (a + b) / 2, T, b - a, H, color);
  for (const [a, b] of doors) batch.box(x, (a + b) / 2, T, b - a, H - DOOR_H, color, DOOR_H);
}

const DOOR_H = 2.1;

function addDoorFrame(batch, f, T, openSide = 1) {
  const fw = 0.06; // kasa genişliği
  const depth = T + 0.04;
  const half = f.w / 2;
  if (f.axis === 'x') {
    batch.box(f.c - half + fw / 2, f.fixed, fw, depth, DOOR_H, COLORS.frame);
    batch.box(f.c + half - fw / 2, f.fixed, fw, depth, DOOR_H, COLORS.frame);
    batch.box(f.c, f.fixed, f.w, depth, fw, COLORS.frame, DOOR_H - fw);
    // Açık kapı kanadı (90°), menteşe sol kasada
    const leafW = f.w - 2 * fw;
    batch.box(f.c - half + fw, f.fixed + openSide * leafW / 2, 0.04, leafW, DOOR_H - fw, COLORS.door);
  } else {
    batch.box(f.fixed, f.c - half + fw / 2, depth, fw, DOOR_H, COLORS.frame);
    batch.box(f.fixed, f.c + half - fw / 2, depth, fw, DOOR_H, COLORS.frame);
    batch.box(f.fixed, f.c, depth, f.w, fw, COLORS.frame, DOOR_H - fw);
    const leafW = f.w - 2 * fw;
    batch.box(f.fixed + openSide * leafW / 2, f.c - half + fw, leafW, 0.04, DOOR_H - fw, COLORS.door);
  }
}

function addHuman(batch, x, z) {
  // 1.70 m referans figür: bacak+gövde silindiri ve baş küresi
  batch.cylinder(x, z, 0.18, 1.48, COLORS.human, 0, 8);
  batch.sphere(x, 1.59, z, 0.11, COLORS.human);
}

function arrowShape(len = 1.6, width = 0.5) {
  const s = new THREE.Shape();
  const hw = width / 2;
  const head = width * 0.9;
  // ShapeGeometry XY düzleminde; -Y yönü rotateX(-90°) sonrası +Z olur.
  // Bu yüzden oku +Y'ye (rotate sonrası −Z = ileri) bakacak şekilde çiziyoruz.
  s.moveTo(-hw * 0.5, -len / 2);
  s.lineTo(hw * 0.5, -len / 2);
  s.lineTo(hw * 0.5, len / 2 - head);
  s.lineTo(hw * 1.2, len / 2 - head);
  s.lineTo(0, len / 2);
  s.lineTo(-hw * 1.2, len / 2 - head);
  s.lineTo(-hw * 0.5, len / 2 - head);
  s.closePath();
  return s;
}

function makeLabel(text, { width = 2, height = 0.5, color = '#1a202c', bg = 'rgba(255,255,255,0.85)' } = {}) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = Math.round(512 * (height / width));
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = color;
  ctx.font = `600 ${Math.round(c.height * 0.5)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(toModel(width), toModel(height)), mat);
  mesh.name = `label:${text}`;
  return mesh;
}

/**
 * Örnek bina maketi. Plan (gerçek metre, kuzey = −Z):
 *   Bina: x ∈ [−7, 7], z ∈ [−13, −3], duvar 3.0 m, kalınlık 0.2 m
 *   Güney cephede giriş kapısı (x = 0), iç duvar z = −8 (kapı x = 0),
 *   iç duvar x = 0 (z ∈ [−13, −8], kapı z ≈ −10.5) → Hol, Oda A (batı), Oda B (doğu)
 *   Kullanıcı başlangıcı: (0, 0, 0), kuzeye (girişe) bakıyor.
 */
export function buildSampleModel() {
  const group = new THREE.Group();
  group.name = 'sampleModel (1:70 maket)';
  const batch = new GeometryBatch();
  const H = 3.0;
  const T = 0.2;
  const frames = [];

  // Zemin ve bina döşemesi
  batch.box(0, -6, 60, 60, 0.02, COLORS.ground, -0.02);
  batch.box(0, -8, 14, 10, 0.03, COLORS.floor, 0);

  // Dış duvarlar
  wallAlongX(batch, -3, -7, 7, [[-0.5, 0.5]], H, T, COLORS.wallOuter, frames);        // güney (giriş)
  wallAlongX(batch, -13, -7, 7, [[4.0, 5.0]], H, T, COLORS.wallOuter, frames);        // kuzey (arka kapı)
  wallAlongZ(batch, -7, -13, -3, [], H, T, COLORS.wallOuter, frames);                 // batı
  wallAlongZ(batch, 7, -13, -3, [[-6.0, -5.0]], H, T, COLORS.wallOuter, frames);      // doğu (yan kapı)
  // İç duvarlar
  wallAlongX(batch, -8, -6.9, 6.9, [[-0.5, 0.5]], H, T * 0.6, COLORS.wall, frames);
  wallAlongZ(batch, 0, -12.9, -8, [[-11.0, -10.0]], H, T * 0.6, COLORS.wall, frames);

  for (const f of frames) addDoorFrame(batch, f, T, f.axis === 'x' ? -1 : 1);

  // Farklı yüksekliklerde kutular (gerçek metre)
  batch.box(-4.5, -5.0, 0.5, 0.5, 0.45, COLORS.box1);   // tabure 45 cm
  batch.box(-3.0, -5.5, 1.6, 0.9, 0.75, COLORS.box2);   // masa 75 cm
  batch.box(4.0, -4.2, 2.4, 0.6, 1.10, COLORS.box3);    // tezgâh 110 cm
  batch.box(-6.4, -10.5, 0.6, 2.0, 2.00, COLORS.box4);  // dolap 200 cm
  batch.box(3.5, -11.0, 1.0, 1.0, 1.70, COLORS.box5);   // 1.70 m referans kutu
  batch.box(-3.0, -11.5, 2.0, 1.4, 0.50, COLORS.box1);  // yatak/sedir 50 cm
  batch.box(-10.0, -8.0, 1.0, 1.0, 6.00, COLORS.box2);  // dışarıda 6 m kule

  // Ölçek referansları: 1.70 m insan figürleri
  addHuman(batch, 1.6, -1.0);
  addHuman(batch, 2.0, -6.0);
  addHuman(batch, -2.0, -10.0);

  // 10 m cetvel (1 m siyah/beyaz) — binanın güneyinde, x ∈ [−5, 5], z = 1.5
  for (let i = 0; i < 10; i++) {
    batch.box(-4.5 + i, 1.5, 1.0, 0.3, 0.03, i % 2 ? COLORS.rulerB : COLORS.rulerA, 0);
  }

  // Yön işaretleri: ileri okları, dönüş okları ve kuzey oku
  const fwd = arrowShape(1.6, 0.5);
  batch.flatShape(fwd, 0, -1.6, 0, COLORS.arrow);          // girişe doğru
  batch.flatShape(fwd, 0, -5.5, 0, COLORS.arrow, 0.045);   // hol içinde (döşeme üstü)
  batch.flatShape(fwd, 2.5, -1.0, -Math.PI / 2, COLORS.arrowRight); // sağ (doğu)
  batch.flatShape(fwd, -2.5, -1.0, Math.PI / 2, COLORS.arrowLeft);  // sol (batı)

  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = batch.build(material);
  mesh.name = 'architecture (merged)';
  group.add(mesh);

  // Grid: 1 m gerçek = 1/70 m maket hücre
  const grid = new THREE.GridHelper(toModel(60), 60, 0x2d3748, 0x4a5568);
  grid.position.set(0, toModel(0.005), toModel(-6));
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  grid.material.depthWrite = false;
  group.add(grid);

  // Etiketler (gerçek metre ile konumlandırılır)
  const labels = [
    { t: 'Ölçek 1:70 — maket içinde insan gözü', p: [0, 2.7, -2.88], w: 4.2, h: 0.45, r: 0 },
    { t: 'HOL', p: [0, 2.4, -7.88], w: 1.4, h: 0.45, r: 0 },
    { t: 'ODA A', p: [-3.5, 2.4, -8.12], w: 1.6, h: 0.45, r: Math.PI },
    { t: 'ODA B', p: [3.5, 2.4, -8.12], w: 1.6, h: 0.45, r: Math.PI },
    { t: '1.70 m', p: [1.6, 1.95, -1.0], w: 0.9, h: 0.3, r: 0 },
    { t: '10 m (maket: 14.3 cm)', p: [0, 0.03, 2.05], w: 3.2, h: 0.4, r: 0, flat: true },
    { t: 'KUZEY ↑ İLERİ', p: [0, 0.02, -0.45], w: 1.6, h: 0.35, r: 0, flat: true },
    { t: '6 m', p: [-10, 6.4, -7.49], w: 0.8, h: 0.35, r: 0 },
  ];
  for (const l of labels) {
    const m = makeLabel(l.t, { width: l.w, height: l.h });
    if (l.flat) m.rotation.x = -Math.PI / 2;
    else m.rotation.y = l.r;
    m.position.set(toModel(l.p[0]), toModel(l.p[1]), toModel(l.p[2]));
    group.add(m);
  }

  return group;
}

/**
 * Harici mimari modeli (.glb / .gltf) yükler.
 * @param {string} url  Sayfaya göre göreli veya mutlak URL
 * @param {{units?: 'maquette'|'real'}} opts
 *   - 'maquette': dosya zaten 1:70 maket boyutunda (1 birim = maket metresi)
 *   - 'real'    : dosya gerçek bina ölçüsünde (1 birim = gerçek metre) → ×1/70 uygulanır
 */
export async function loadArchitecturalModel(url, { units = 'real' } = {}) {
  const resolved = new URL(url, document.baseURI).href;
  const gltf = await new GLTFLoader().loadAsync(resolved);
  const root = gltf.scene;
  root.name = `gltf:${url}`;
  if (units === 'real') root.scale.setScalar(SCALE.ratio);
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = true;
    }
  });
  return root;
}

/** Bir nesneyi ve alt öğelerinin GPU kaynaklarını serbest bırakır. */
export function disposeObject(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
}
