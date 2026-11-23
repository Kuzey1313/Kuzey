/**
 * main.js — Uygulama giriş noktası.
 *
 * Bileşenler:
 *   ScaleSystem (scene.js)      1:70 maket kökü ve görüntü ölçeği
 *   XRManager (xr-manager.js)   immersive-vr oturumu
 *   XRHandTracking              Quest 3 eklem verisi  ─┐
 *   DesktopHandTracker          MediaPipe landmark'ları ├─► GestureEngine ─► Locomotion ─► rig
 *   Klavye (yalnızca masaüstü debug) ─────────────────────┘
 *
 * Sahne hiyerarşisi:
 *   scene
 *    ├─ modelRoot (scale = viewScale; içerik maket biriminde)
 *    └─ rig  (tracking space'in dünyadaki yeri; locomotion yalnızca bunu hareket ettirir)
 *        ├─ camera (XR'da poz her karede WebXR'dan gelir)
 *        │    └─ hud (VR durum göstergesi)
 *        └─ hand[0], hand[1]
 */
import * as THREE from 'three';
import { XRManager, XR_STATE } from './xr-manager.js';
import { XRHandTracking } from './hand-tracking.js';
import { GestureEngine, GESTURE_LABEL, Gesture } from './gestures.js';
import { Locomotion } from './locomotion.js';
import { DesktopHandTracker } from './desktop-hands.js';
import {
  SCALE, ScaleSystem, buildSampleModel, loadArchitecturalModel, disposeObject,
} from './scene.js';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const ui = {
  canvasHost: $('app'),
  btnVR: $('btn-vr'),
  btnCamStart: $('btn-cam-start'),
  btnCamStop: $('btn-cam-stop'),
  btnReset: $('btn-reset'),
  selView: $('sel-view'),
  video: $('cam-video'),
  overlay: $('cam-overlay'),
  camPanel: $('cam-panel'),
  toast: $('toast'),
  consent: $('consent'),
  consentOk: $('consent-ok'),
  consentCancel: $('consent-cancel'),
  dbg: {
    xr: $('dbg-xr'),
    ref: $('dbg-ref'),
    hand: $('dbg-hand'),
    activeHand: $('dbg-active-hand'),
    pinch: $('dbg-pinch'),
    dist: $('dbg-dist'),
    fwd: $('dbg-fwd'),
    rot: $('dbg-rot'),
    scale: $('dbg-scale'),
    eye: $('dbg-eye'),
    pos: $('dbg-pos'),
    fps: $('dbg-fps'),
  },
};

let toastTimer = 0;
function toast(msg, kind = 'info', ms = 5000) {
  if (!msg) return;
  ui.toast.textContent = msg;
  ui.toast.dataset.kind = kind;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, ms);
}

// ---------------------------------------------------------------------------
// Renderer / sahne
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setFoveation(1);
ui.canvasHost.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfd4e6);
scene.fog = new THREE.Fog(0xbfd4e6, 40, 120);
scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7a5a, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(0.6, 1, 0.35);
scene.add(sun);

const scaleSystem = new ScaleSystem(scene);
let architecture = buildSampleModel();
scaleSystem.modelRoot.add(architecture);

// Kamera: near/far gerçek metre (tracking space) cinsinden
const DESKTOP_FOV = 70;
const camera = new THREE.PerspectiveCamera(DESKTOP_FOV, window.innerWidth / window.innerHeight, 0.01, 300);
camera.rotation.order = 'YXZ';
const rig = new THREE.Group();
rig.name = 'rig';
rig.add(camera);
scene.add(rig);

/** Masaüstünde takip yok: göz yüksekliği referans değeri kullanılır. VR'da kullanılmaz. */
function applyDesktopCamera() {
  camera.position.set(0, SCALE.eyeHeight, 0);
  camera.rotation.set(desktopLook.pitch, desktopLook.yaw, 0);
}
const desktopLook = { yaw: 0, pitch: 0 };
applyDesktopCamera();

const locomotion = new Locomotion(rig, camera);
locomotion.setStart(new THREE.Vector3(0, 0, 0), 0);

const engine = new GestureEngine();
const xrHands = new XRHandTracking(renderer, rig);
const desktopHands = new DesktopHandTracker({ video: ui.video, canvas: ui.overlay });
desktopHands.onError = (err) => { toast(err.message, 'error'); updateCameraButtons(); };

// ---------------------------------------------------------------------------
// VR durum göstergesi (HUD): görüşün alt kısmında küçük panel
// ---------------------------------------------------------------------------
const hud = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.075), mat);
  mesh.position.set(0, -0.2, -0.7); // ~16° aşağıda, 70 cm ileride
  mesh.rotation.x = -0.25;
  mesh.renderOrder = 999;
  mesh.visible = false;
  camera.add(mesh);
  let lastKey = '';

  function draw({ forward, rotation, tracking, warn, handLabel }) {
    const key = `${forward}|${rotation}|${tracking}|${warn}|${handLabel}`;
    if (key === lastKey) return;
    lastKey = key;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(15,20,30,0.72)';
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 28);
    ctx.fill();

    // Takip noktası
    ctx.fillStyle = tracking ? '#48bb78' : '#e53e3e';
    ctx.beginPath();
    ctx.arc(36, 44, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '600 30px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(tracking ? `El: ${handLabel}` : 'El takibi yok', 62, 44);
    ctx.textAlign = 'right';
    ctx.fillText(`1:${SCALE.denominator}`, W - 24, 44);
    ctx.textAlign = 'left';

    // Hareket simgeleri
    const cells = [
      { on: rotation < 0, t: '⟲ SOL', c: '#38a169' },
      { on: forward, t: '▲ İLERİ', c: '#3182ce' },
      { on: rotation > 0, t: 'SAĞ ⟳', c: '#dd6b20' },
    ];
    const cw = (W - 48) / 3;
    cells.forEach((cell, i) => {
      const x = 24 + i * cw;
      ctx.fillStyle = cell.on ? cell.c : 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.roundRect(x + 4, 78, cw - 8, 60, 14);
      ctx.fill();
      ctx.fillStyle = cell.on ? '#ffffff' : '#a0aec0';
      ctx.font = '700 28px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(cell.t, x + cw / 2, 108);
      ctx.textAlign = 'left';
    });

    if (warn) {
      ctx.fillStyle = 'rgba(197,48,48,0.95)';
      ctx.fillRect(0, 0, W, 18);
    }
    tex.needsUpdate = true;
  }
  return { mesh, draw };
})();

// ---------------------------------------------------------------------------
// XR yaşam döngüsü
// ---------------------------------------------------------------------------
const xr = new XRManager(renderer, ui.btnVR);
let xrStartedAt = 0;
let handWarningShown = false;

xr.addEventListener('statechange', (e) => {
  const { state, message } = e.detail;
  if (message) toast(message, state === XR_STATE.ERROR || state === XR_STATE.UNSUPPORTED ? 'warn' : 'info');
});

xr.addEventListener('sessionstart', () => {
  // Masaüstü kamera işleyicisi XR ile çakışmasın: tamamen kapat.
  if (desktopHands.running || desktopHands.starting) {
    desktopHands.stop();
    toast('VR başladı: webcam takibi kapatıldı, Quest hand tracking kullanılıyor.');
  }
  ui.camPanel.hidden = true;
  updateCameraButtons();
  engine.reset();
  locomotion.stop();
  hud.mesh.visible = true;
  xrStartedAt = performance.now();
  handWarningShown = false;
  // Kamera pozu artık WebXR'dan gelecek; masaüstü bakış açısını sıfırla.
  camera.position.set(0, 0, 0);
  camera.quaternion.identity();
  if (xr.handTrackingEnabled === false) handWarningShown = true;
});

xr.addEventListener('sessionend', () => {
  engine.reset();
  locomotion.stop();
  hud.mesh.visible = false;
  // Masaüstü moduna temiz dönüş: kamera ve görüntü boyutunu geri yükle.
  // (Three.js XR sırasında kullanıcı kamerasının fov/projection değerini XR'ınkiyle değiştirir.)
  camera.fov = DESKTOP_FOV;
  camera.zoom = 1;
  applyDesktopCamera();
  onResize();
  updateCameraButtons();
});

xr.addEventListener('inputchange', (e) => {
  if (e.detail.controllers > 0 && e.detail.hands === 0) {
    toast('Kontrolcüler algılandı. Hand tracking için kontrolcüleri bırakın.', 'warn');
  }
});

// ---------------------------------------------------------------------------
// Masaüstü kamera (açık izin akışı)
// ---------------------------------------------------------------------------
function updateCameraButtons() {
  const presenting = renderer.xr.isPresenting;
  ui.btnCamStart.disabled = presenting || desktopHands.running || desktopHands.starting;
  ui.btnCamStop.disabled = !(desktopHands.running || desktopHands.starting);
  ui.camPanel.hidden = !desktopHands.running;
}

function askCameraConsent() {
  return new Promise((resolve) => {
    ui.consent.hidden = false;
    const done = (v) => {
      ui.consent.hidden = true;
      ui.consentOk.removeEventListener('click', ok);
      ui.consentCancel.removeEventListener('click', cancel);
      resolve(v);
    };
    const ok = () => done(true);
    const cancel = () => done(false);
    ui.consentOk.addEventListener('click', ok);
    ui.consentCancel.addEventListener('click', cancel);
    ui.consentOk.focus();
  });
}

ui.btnCamStart.addEventListener('click', async () => {
  if (renderer.xr.isPresenting) return;
  const ok = await askCameraConsent();
  if (!ok) { toast('Kamera başlatılmadı (kullanıcı onay vermedi).'); return; }
  ui.btnCamStart.disabled = true;
  ui.btnCamStop.disabled = false;
  toast('Kamera ve MediaPipe modeli yükleniyor…', 'info', 3000);
  try {
    await desktopHands.start();
    // Başlatma sürerken VR'a geçildiyse hemen kapat
    if (renderer.xr.isPresenting) desktopHands.stop();
    else toast('El takibi başladı. Başparmak + işaret parmağı ile ileri yürüyün.', 'ok', 3500);
  } catch (err) {
    toast(err.message, 'error', 8000);
  }
  updateCameraButtons();
});

ui.btnCamStop.addEventListener('click', () => {
  desktopHands.stop();
  engine.reset();
  locomotion.stop();
  updateCameraButtons();
});

ui.btnReset.addEventListener('click', () => {
  if (!renderer.xr.isPresenting) {
    desktopLook.yaw = 0;
    desktopLook.pitch = 0;
    applyDesktopCamera();
  }
  locomotion.reset({ alignHead: renderer.xr.isPresenting });
  toast('Pozisyon sıfırlandı.', 'info', 1500);
});

ui.selView.addEventListener('change', () => {
  scaleSystem.setMode(ui.selView.value, rig);
});

// ---------------------------------------------------------------------------
// Masaüstü: fare ile bakış + klavye (debug yedeği; aynı locomotion'ı kullanır)
// ---------------------------------------------------------------------------
const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

let dragging = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (renderer.xr.isPresenting) return;
  dragging = { x: e.clientX, y: e.clientY };
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging || renderer.xr.isPresenting) return;
  desktopLook.yaw -= (e.clientX - dragging.x) * 0.004;
  desktopLook.pitch -= (e.clientY - dragging.y) * 0.004;
  desktopLook.pitch = THREE.MathUtils.clamp(desktopLook.pitch, -1.45, 1.45);
  dragging = { x: e.clientX, y: e.clientY };
  camera.rotation.set(desktopLook.pitch, desktopLook.yaw, 0);
});
const endDrag = () => { dragging = null; };
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

function keyboardIntent() {
  const forward = keys.has('KeyW') || keys.has('ArrowUp');
  const r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  return { forward, rotation: r };
}

// ---------------------------------------------------------------------------
// Opsiyonel GLB/GLTF: ?model=assets/models/bina.glb&units=real|maquette
// ---------------------------------------------------------------------------
async function maybeLoadExternalModel() {
  const params = new URLSearchParams(location.search);
  const url = params.get('model');
  if (!url) return;
  const units = params.get('units') === 'maquette' ? 'maquette' : 'real';
  try {
    toast(`Model yükleniyor: ${url}`, 'info', 3000);
    const model = await loadArchitecturalModel(url, { units });
    scaleSystem.modelRoot.remove(architecture);
    disposeObject(architecture);
    architecture = model;
    scaleSystem.modelRoot.add(architecture);
    toast(`Model yüklendi (${units === 'real' ? 'gerçek ölçü → ×1/70' : 'maket ölçüsü'}).`, 'ok');
  } catch (err) {
    console.error(err);
    toast(`Model yüklenemedi, örnek sahne kullanılıyor: ${err.message}`, 'error', 8000);
  }
}

// ---------------------------------------------------------------------------
// Ana döngü (masaüstü ve VR için tek döngü: renderer.setAnimationLoop)
// ---------------------------------------------------------------------------
let lastTime = null;
let fpsFrames = 0;
let fpsTime = performance.now();
let fps = 0;
let lastUi = 0;
let lastGesture = engine.last;
const tmpV = new THREE.Vector3();

const handLabel = (h) => (h === 'left' ? 'Sol' : h === 'right' ? 'Sağ' : '?');

function loop(time, frame) {
  const dt = lastTime === null ? 0 : (time - lastTime) / 1000;
  lastTime = time;
  const now = performance.now();
  const presenting = renderer.xr.isPresenting;

  // 1) El verisi: VR → WebXR eklemleri, masaüstü → MediaPipe
  let hands = [];
  if (presenting) {
    hands = xrHands.update(frame, renderer.xr.getReferenceSpace());
  } else if (desktopHands.running) {
    hands = desktopHands.update(now);
  }

  // 2) Ortak jest motoru
  const g = engine.update(hands);
  lastGesture = g;

  // 3) Niyet (masaüstünde klavye yedeği eklenir)
  let intent = { forward: g.forward, rotation: g.rotation };
  if (!presenting) {
    const k = keyboardIntent();
    intent = { forward: intent.forward || k.forward, rotation: intent.rotation || k.rotation };
  }
  locomotion.setIntent(intent);
  locomotion.update(dt);

  // 4) Görsel geri bildirim
  if (desktopHands.running) desktopHands.draw(g.perHand);
  if (presenting) {
    const tracking = g.handCount > 0;
    const noHandsYet = xr.inputs.hands === 0 && now - xrStartedAt > 4000;
    if (noHandsYet && !handWarningShown) {
      handWarningShown = true;
      toast('Quest hand tracking verisi gelmiyor. Ayarlar > Hareket takibi > El ve vücut takibi açık olmalı.', 'warn', 8000);
    }
    hud.draw({
      forward: intent.forward,
      rotation: intent.rotation,
      tracking,
      warn: xr.handTrackingEnabled === false || noHandsYet,
      handLabel: g.perHand.map((h) => handLabel(h.handedness)).join(' + ') || '-',
    });
  }

  renderer.render(scene, camera);

  // 5) FPS + debug paneli (~8 Hz)
  fpsFrames++;
  if (now - fpsTime >= 1000) {
    fps = Math.round((fpsFrames * 1000) / (now - fpsTime));
    fpsFrames = 0;
    fpsTime = now;
  }
  if (now - lastUi > 125) {
    lastUi = now;
    updateDebug(presenting);
  }
}

function updateDebug(presenting) {
  const d = ui.dbg;
  const g = lastGesture;
  d.xr.textContent = xr.stateLabel;
  d.ref.textContent = xr.referenceSpaceType ?? '-';

  if (presenting) {
    const s = xrHands.status;
    const ht = xr.handTrackingEnabled === false ? 'özellik reddedildi'
      : `WebXR · ${s.trackedHands}/${s.handInputs} el takipte${s.controllers ? ` · ${s.controllers} kontrolcü` : ''}`;
    d.hand.textContent = ht;
  } else if (desktopHands.running || desktopHands.starting) {
    d.hand.textContent = `Webcam (MediaPipe) · ${desktopHands.status} · ${g.handCount} el`;
  } else {
    d.hand.textContent = 'Kapalı';
  }

  d.activeHand.textContent = g.perHand.length
    ? g.perHand.map((h) => handLabel(h.handedness)).join(', ')
    : '-';

  const active = g.perHand.filter((h) => h.gesture !== Gesture.NONE);
  let pinch = active.map((h) => `${handLabel(h.handedness)}: ${GESTURE_LABEL[h.gesture]}`).join(' | ');
  if (g.conflict) pinch += ' (zıt dönüş → iptal)';
  if (!pinch && g.perHand.some((h) => h.ambiguous)) pinch = 'Belirsiz (hareket yok)';
  d.pinch.textContent = pinch || GESTURE_LABEL[Gesture.NONE];

  d.dist.textContent = g.perHand.length
    ? g.perHand.map((h) => {
      const x = h.distances;
      return `${handLabel(h.handedness)} İ:${x.index.toFixed(2)} Y:${x.ring.toFixed(2)} S:${x.pinky.toFixed(2)}`;
    }).join(' · ')
    : '-';

  const k = SCALE.denominator / scaleSystem.viewScale; // dünya metresi → gerçek bina metresi
  const v = locomotion.state.forwardSpeed;
  d.fwd.textContent = `${v.toFixed(2)} m/s tracking · ${(v * k).toFixed(2)} m/s bina · ${(v * k / SCALE.denominator * 100).toFixed(2)} cm/s maket`;
  d.rot.textContent = `${locomotion.state.rotationSpeedDeg.toFixed(1)} °/s`;
  d.scale.textContent = scaleSystem.label;

  camera.getWorldPosition(tmpV);
  const eyeWorld = tmpV.y;
  const eyeModel = eyeWorld / scaleSystem.viewScale;
  d.eye.textContent = `${(eyeModel * SCALE.denominator).toFixed(2)} m bina · ${eyeModel.toFixed(5)} maket birimi${presenting ? ' (WebXR)' : ' (masaüstü ref.)'}`;
  scaleSystem.worldToReal(tmpV, tmpV);
  d.pos.textContent = `x ${tmpV.x.toFixed(2)}  z ${tmpV.z.toFixed(2)} (bina m)`;
  d.fps.textContent = String(fps);
}

// ---------------------------------------------------------------------------
// Boyutlandırma, temizlik, başlatma
// ---------------------------------------------------------------------------
function onResize() {
  if (renderer.xr.isPresenting) return; // XR çözünürlüğü cihaz yönetir
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);

window.addEventListener('pagehide', () => {
  desktopHands.dispose();
  xr.end();
});

document.addEventListener('visibilitychange', () => {
  // Sekme gizlenince yürüme "takılı" kalmasın
  if (document.hidden) { keys.clear(); locomotion.stop(); }
});

renderer.setAnimationLoop(loop);
updateCameraButtons();
xr.init();
maybeLoadExternalModel();

// Konsoldan inceleme için (debug)
window.__app = { renderer, scene, rig, camera, scaleSystem, engine, locomotion, xr };
