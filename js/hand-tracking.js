/**
 * hand-tracking.js — Quest 3 native WebXR Hand Tracking.
 *
 * Eklem pozisyonları doğrudan XRFrame.getJointPose() ile, Three.js'in kullandığı
 * referans alanında (tracking-space, gerçek metre) okunur. Bu değerler 1:70
 * ölçekten tamamen bağımsızdır; jest eşikleri gerçek el ölçüsüyle çalışır.
 *
 * Görselleştirme için Three.js'in XRHandModelFactory 'spheres' profili
 * kullanılır (InstancedMesh → el başına tek draw call, ağ üzerinden model
 * indirmez).
 */
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

/** Ortak gesture formatı → WebXR eklem adı */
export const XR_JOINTS = Object.freeze({
  wrist: 'wrist',
  thumbTip: 'thumb-tip',
  indexTip: 'index-finger-tip',
  middleTip: 'middle-finger-tip',
  ringTip: 'ring-finger-tip',
  pinkyTip: 'pinky-finger-tip',
  // MCP (knuckle) eklemi = proksimal falanksın başlangıcı. MediaPipe #9 ile aynı nokta.
  middleMcp: 'middle-finger-phalanx-proximal',
});

const JOINT_KEYS = Object.keys(XR_JOINTS);

function makePointSet() {
  const o = {};
  for (const k of JOINT_KEYS) o[k] = { x: 0, y: 0, z: 0 };
  return o;
}

export class XRHandTracking {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Object3D} rig  El modellerinin ebeveyni (kamera ile aynı uzay).
   */
  constructor(renderer, rig) {
    this.renderer = renderer;
    this.handModels = [];
    const factory = new XRHandModelFactory();
    for (let i = 0; i < 2; i++) {
      const hand = renderer.xr.getHand(i);
      hand.add(factory.createHandModel(hand, 'spheres'));
      rig.add(hand);
      this.handModels.push(hand);
    }
    // GC baskısını azaltmak için önceden ayrılmış nesneler
    this._points = { left: makePointSet(), right: makePointSet(), none: makePointSet() };
    this._out = [];
    this.status = { handInputs: 0, trackedHands: 0, controllers: 0 };
  }

  /**
   * @param {XRFrame} frame
   * @param {XRReferenceSpace} refSpace
   * @returns {Array<{id:string, handedness:string, points:object}>}
   */
  update(frame, refSpace) {
    const out = this._out;
    out.length = 0;
    let handInputs = 0;
    let controllers = 0;

    if (!frame || !refSpace) {
      this.status = { handInputs, trackedHands: 0, controllers };
      return out;
    }

    for (const source of frame.session.inputSources) {
      if (!source.hand) {
        if (source.gamepad) controllers++;
        continue;
      }
      handInputs++;
      const handedness = source.handedness === 'left' || source.handedness === 'right'
        ? source.handedness : 'none';
      const pts = this._points[handedness];
      let tracked = true;
      for (const key of JOINT_KEYS) {
        const space = source.hand.get(XR_JOINTS[key]);
        const pose = space ? frame.getJointPose(space, refSpace) : null;
        if (!pose) { tracked = false; break; } // el görüş dışında / takip kayıp
        const p = pose.transform.position;
        const t = pts[key];
        t.x = p.x; t.y = p.y; t.z = p.z;
      }
      if (tracked) out.push({ id: handedness, handedness, points: pts });
    }

    this.status = { handInputs, trackedHands: out.length, controllers };
    return out;
  }
}
