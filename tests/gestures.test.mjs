// Jest motoru birim testleri — bağımlılık gerektirmez.
// Çalıştırma:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Gesture,
  HandGestureState,
  GestureEngine,
  normalizedPinchDistances,
  handSize,
  isValidHand,
} from '../js/gestures.js';

/**
 * Sentetik el üretir. Başparmak ucundan her parmak ucuna olan normalize
 * mesafe (el büyüklüğüne oranla) parametre olarak verilir.
 * Parmak uçları farklı yönlere yerleştirilir; yalnızca mesafeler önemlidir.
 */
function makeHand({ index = 1, middle = 1, ring = 1, pinky = 1 } = {}, size = 0.09, origin = { x: 0, y: 0, z: 0 }) {
  const o = origin;
  const p = (x, y, z) => ({ x: o.x + x, y: o.y + y, z: o.z + z });
  const thumb = p(0.4 * size, 0.9 * size, 0.1 * size);
  const at = (dir, d) => {
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    return {
      x: thumb.x + (dir[0] / len) * d * size,
      y: thumb.y + (dir[1] / len) * d * size,
      z: thumb.z + (dir[2] / len) * d * size,
    };
  };
  return {
    wrist: p(0, 0, 0),
    middleMcp: p(0, size, 0),
    thumbTip: thumb,
    indexTip: at([0, 1, 0], index),
    middleTip: at([-1, 1, 0], middle),
    ringTip: at([-1, 0, 1], ring),
    pinkyTip: at([0, 0, -1], pinky),
  };
}

const OPEN = { index: 0.9, middle: 1.1, ring: 1.0, pinky: 1.0 };

test('el büyüklüğü ve normalize mesafeler doğru hesaplanır', () => {
  const h = makeHand({ index: 0.2, middle: 0.8, ring: 0.6, pinky: 0.7 }, 0.1);
  assert.ok(Math.abs(handSize(h) - 0.1) < 1e-12);
  const d = normalizedPinchDistances(h);
  assert.ok(Math.abs(d.index - 0.2) < 1e-9);
  assert.ok(Math.abs(d.middle - 0.8) < 1e-9);
  assert.ok(Math.abs(d.ring - 0.6) < 1e-9);
  assert.ok(Math.abs(d.pinky - 0.7) < 1e-9);
});

test('açık el → jest yok', () => {
  const s = new HandGestureState();
  assert.equal(s.update(makeHand(OPEN)).gesture, Gesture.NONE);
});

test('başparmak + işaret → ileri', () => {
  const s = new HandGestureState();
  assert.equal(s.update(makeHand({ ...OPEN, index: 0.1 })).gesture, Gesture.FORWARD);
});

test('başparmak + serçe → sağa dönüş', () => {
  const s = new HandGestureState();
  assert.equal(s.update(makeHand({ ...OPEN, pinky: 0.15 })).gesture, Gesture.ROTATE_RIGHT);
});

test('başparmak + yüzük → sola dönüş', () => {
  const s = new HandGestureState();
  assert.equal(s.update(makeHand({ ...OPEN, ring: 0.15 })).gesture, Gesture.ROTATE_LEFT);
});

test('hysteresis: press ile release arasında durum korunur', () => {
  const s = new HandGestureState(); // index press 0.25, release 0.38
  assert.equal(s.update(makeHand({ ...OPEN, index: 0.30 })).gesture, Gesture.NONE, 'press eşiğinin üstünde başlamaz');
  assert.equal(s.update(makeHand({ ...OPEN, index: 0.20 })).gesture, Gesture.FORWARD);
  assert.equal(s.update(makeHand({ ...OPEN, index: 0.33 })).gesture, Gesture.FORWARD, 'ara bölgede bırakılmaz');
  assert.equal(s.update(makeHand({ ...OPEN, index: 0.40 })).gesture, Gesture.NONE, 'release eşiği aşılınca durur');
});

test('pinch bırakılınca aynı karede durur', () => {
  const s = new HandGestureState();
  s.update(makeHand({ ...OPEN, index: 0.1 }));
  assert.equal(s.update(makeHand(OPEN)).gesture, Gesture.NONE);
});

test('ölçekten bağımsızlık: küçük ve büyük el aynı sonucu verir', () => {
  for (const size of [0.06, 0.09, 0.12, 9, 900]) {
    const s = new HandGestureState();
    assert.equal(s.update(makeHand({ ...OPEN, ring: 0.2 }, size)).gesture, Gesture.ROTATE_LEFT, `size=${size}`);
  }
});

test('kilitleme: yüzük pinch sürerken serçe yaklaşsa da yön değişmez', () => {
  const s = new HandGestureState();
  assert.equal(s.update(makeHand({ ...OPEN, ring: 0.15 })).gesture, Gesture.ROTATE_LEFT);
  assert.equal(s.update(makeHand({ ...OPEN, ring: 0.2, pinky: 0.05 })).gesture, Gesture.ROTATE_LEFT);
});

test('aynı anda iki pinch: belirgin şekilde yakın olan seçilir', () => {
  const s = new HandGestureState();
  assert.equal(s.update(makeHand({ ...OPEN, ring: 0.28, pinky: 0.08 })).gesture, Gesture.ROTATE_RIGHT);
});

test('zıt dönüşler belirsizse hareket üretilmez', () => {
  const s = new HandGestureState();
  const r = s.update(makeHand({ ...OPEN, ring: 0.15, pinky: 0.16 }));
  assert.equal(r.gesture, Gesture.NONE);
  assert.equal(r.ambiguous, true);
});

test('belirsizlikte öncelik: ileri, dönüşe baskın gelir', () => {
  const s = new HandGestureState();
  assert.equal(s.update(makeHand({ ...OPEN, index: 0.18, ring: 0.15 })).gesture, Gesture.FORWARD);
});

test('orta parmak koruması: asıl pinch orta parmaktaysa yüzük jesti seçilmez', () => {
  const s = new HandGestureState();
  assert.equal(s.update(makeHand({ ...OPEN, middle: 0.08, ring: 0.27 })).gesture, Gesture.NONE);
});

test('geçersiz veri → reset ve jest yok', () => {
  const s = new HandGestureState();
  s.update(makeHand({ ...OPEN, index: 0.1 }));
  const bad = makeHand(OPEN);
  bad.thumbTip = { x: NaN, y: 0, z: 0 };
  assert.equal(isValidHand(bad), false);
  const r = s.update(bad);
  assert.equal(r.valid, false);
  assert.equal(r.gesture, Gesture.NONE);
  assert.equal(s.update(null).gesture, Gesture.NONE);
});

test('sıfır el büyüklüğü güvenli şekilde reddedilir', () => {
  const h = makeHand(OPEN);
  h.middleMcp = { ...h.wrist };
  assert.equal(normalizedPinchDistances(h), null);
});

test('motor: el yokken hareket yok', () => {
  const e = new GestureEngine();
  const r = e.update([]);
  assert.equal(r.forward, false);
  assert.equal(r.rotation, 0);
  assert.equal(r.handCount, 0);
});

test('motor: iki el — biri yürür, diğeri döner', () => {
  const e = new GestureEngine();
  const r = e.update([
    { id: 'left', handedness: 'left', points: makeHand({ ...OPEN, index: 0.1 }) },
    { id: 'right', handedness: 'right', points: makeHand({ ...OPEN, pinky: 0.1 }) },
  ]);
  assert.equal(r.forward, true);
  assert.equal(r.rotation, 1);
  assert.equal(r.handCount, 2);
});

test('motor: allowWalkAndTurn=false iken ileri önceliklidir', () => {
  const e = new GestureEngine({ allowWalkAndTurn: false });
  const r = e.update([
    { id: 'left', points: makeHand({ ...OPEN, index: 0.1 }) },
    { id: 'right', points: makeHand({ ...OPEN, ring: 0.1 }) },
  ]);
  assert.equal(r.forward, true);
  assert.equal(r.rotation, 0);
});

test('motor: iki el zıt dönüş isterse rotasyon iptal edilir', () => {
  const e = new GestureEngine();
  const r = e.update([
    { id: 'left', points: makeHand({ ...OPEN, ring: 0.1 }) },
    { id: 'right', points: makeHand({ ...OPEN, pinky: 0.1 }) },
  ]);
  assert.equal(r.rotation, 0);
  assert.equal(r.conflict, true);
});

test('motor: el kaybolunca durumu sıfırlanır (tekrar girince hysteresis temiz başlar)', () => {
  const e = new GestureEngine();
  e.update([{ id: 'right', points: makeHand({ ...OPEN, index: 0.1 }) }]);
  assert.equal(e.update([]).forward, false);
  // Ara bölgede (0.33) yeniden girdiğinde önceki "basılı" durum taşınmamalı.
  assert.equal(e.update([{ id: 'right', points: makeHand({ ...OPEN, index: 0.33 }) }]).forward, false);
});

// ---------------------------------------------------------------------------
// MediaPipe → ortak format dönüştürücü
// ---------------------------------------------------------------------------
import { mediapipeToHands, MP_LANDMARKS } from '../js/desktop-hands.js';

function fakeMediapipeResult(label, pinchFinger) {
  const lm = Array.from({ length: 21 }, (_, i) => ({ x: 0.5 + i * 0.001, y: 0.5, z: 0 }));
  const world = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  world[MP_LANDMARKS.wrist] = { x: 0, y: 0, z: 0 };
  world[MP_LANDMARKS.middleMcp] = { x: 0, y: -0.09, z: 0 };
  world[MP_LANDMARKS.thumbTip] = { x: 0.05, y: -0.08, z: 0 };
  world[MP_LANDMARKS.indexTip] = { x: 0.02, y: -0.17, z: 0 };
  world[MP_LANDMARKS.middleTip] = { x: 0.0, y: -0.18, z: 0 };
  world[MP_LANDMARKS.ringTip] = { x: -0.02, y: -0.17, z: 0 };
  world[MP_LANDMARKS.pinkyTip] = { x: -0.04, y: -0.15, z: 0 };
  if (pinchFinger) world[MP_LANDMARKS[pinchFinger]] = { x: 0.055, y: -0.085, z: 0.005 };
  return { landmarks: [lm], worldLandmarks: [world], handedness: [[{ categoryName: label, score: 0.98 }]] };
}

test('MediaPipe: worldLandmarks kullanılır ve el etiketi aynasız kamera için çevrilir', () => {
  const hands = mediapipeToHands(fakeMediapipeResult('Left'));
  assert.equal(hands.length, 1);
  assert.equal(hands[0].handedness, 'right');
  assert.ok(Math.abs(hands[0].points.middleMcp.y + 0.09) < 1e-12);
});

test('MediaPipe → gesture engine uçtan uca: işaret pinch = ileri, yüzük pinch = sola', () => {
  const e = new GestureEngine();
  assert.equal(e.update(mediapipeToHands(fakeMediapipeResult('Right'))).forward, false);
  assert.equal(e.update(mediapipeToHands(fakeMediapipeResult('Right', 'indexTip'))).forward, true);
  const e2 = new GestureEngine();
  assert.equal(e2.update(mediapipeToHands(fakeMediapipeResult('Right', 'ringTip'))).rotation, -1);
});

test('MediaPipe: boş/eksik sonuç güvenli', () => {
  assert.deepEqual(mediapipeToHands(null), []);
  assert.deepEqual(mediapipeToHands({ landmarks: [[{ x: 0, y: 0, z: 0 }]] }), []);
});
