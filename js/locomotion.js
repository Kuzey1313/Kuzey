/**
 * locomotion.js — Frame-rate bağımsız yürüme ve dönme.
 *
 * Hareket her zaman "rig" (XR tracking space'in sahnedeki karşılığı) üzerinde
 * yapılır. Kamera (baş) pozisyonuna asla yazılmaz; WebXR'ın verdiği gerçek baş
 * pozu korunur.
 *
 *  - İleri: başın baktığı yönün YATAY (XZ) izdüşümü. Başı yukarı/aşağı eğmek
 *    yürüyüşü etkilemez.
 *  - Dönme: dünya Y ekseni etrafında, ekseni kullanıcının BAŞ pozisyonundan
 *    geçirerek. Böylece odanın ortasında durmayan kullanıcı dönerken bir yay
 *    üzerinde savrulmaz.
 *  - Hızlanma kısa bir ease-in rampasıyla yumuşatılır; bırakıldığında hareket
 *    aynı karede durur (spesifikasyon gereği).
 */
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

export const LOCOMOTION_DEFAULTS = Object.freeze({
  /** Yürüme hızı, tracking-space metre/sn (insan perspektifinde gerçek ölçek). */
  walkSpeed: 1.3,
  /** Dönüş hızı, derece/sn. */
  turnSpeedDeg: 50,
  /** Tam hıza ulaşma süresi (sn). */
  rampTime: 0.25,
  /** Tek karede uygulanacak en uzun deltaTime (sekme geçişleri vb. için). */
  maxDelta: 0.1,
});

/** smoothstep tabanlı ease-in-out: 0..1 → 0..1 */
function ease(t) {
  const x = Math.min(Math.max(t, 0), 1);
  return x * x * (3 - 2 * x);
}

export class Locomotion {
  /**
   * @param {THREE.Object3D} rig     Kamerayı ve elleri taşıyan grup (sahne kökünün çocuğu).
   * @param {THREE.Camera} camera    Rig'in çocuğu olan kamera.
   * @param {object} [options]
   */
  constructor(rig, camera, options = {}) {
    this.rig = rig;
    this.camera = camera;
    this.options = { ...LOCOMOTION_DEFAULTS, ...options };

    this.startPosition = rig.position.clone();
    this.startQuaternion = rig.quaternion.clone();

    this.intent = { forward: false, rotation: 0 };
    this.forwardHeld = 0;
    this.turnHeld = 0;
    this.lastTurnDir = 0;

    /** Debug için anlık hızlar. */
    this.state = { forwardSpeed: 0, rotationSpeedDeg: 0 };

    this._dir = new THREE.Vector3();
    this._head = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._camQ = new THREE.Quaternion();
  }

  setStart(position, yawRad = 0) {
    this.startPosition.copy(position);
    this.startQuaternion.setFromAxisAngle(UP, yawRad);
  }

  /** @param {{forward:boolean, rotation:number}} intent */
  setIntent(intent) {
    this.intent.forward = !!intent.forward;
    this.intent.rotation = Math.sign(intent.rotation || 0);
  }

  stop() {
    this.intent.forward = false;
    this.intent.rotation = 0;
    this.forwardHeld = 0;
    this.turnHeld = 0;
    this.state.forwardSpeed = 0;
    this.state.rotationSpeedDeg = 0;
  }

  /** Başın dünya uzayındaki yatay bakış yönü (birim vektör). */
  getHorizontalHeading(target = new THREE.Vector3()) {
    this.camera.updateMatrixWorld();
    this.camera.getWorldDirection(target);
    target.y = 0;
    if (target.lengthSq() < 1e-6) {
      // Tam aşağı/yukarı bakılıyorsa kameranın "üst" vektörü yatay yönü verir.
      this.camera.getWorldQuaternion(this._camQ);
      target.set(0, 1, 0).applyQuaternion(this._camQ);
      // Aşağı bakarken başın tepesi ileriyi gösterir; yukarı bakarken tersini.
      if (this.camera.getWorldDirection(this._dir).y > 0) target.negate();
      target.y = 0;
    }
    if (target.lengthSq() < 1e-6) target.set(0, 0, -1);
    return target.normalize();
  }

  /** @param {number} dt saniye */
  update(dt) {
    const o = this.options;
    dt = Math.min(Math.max(dt, 0), o.maxDelta);

    // --- İleri yürüme -----------------------------------------------------
    if (this.intent.forward) {
      this.forwardHeld += dt;
      const speed = o.walkSpeed * ease(this.forwardHeld / o.rampTime);
      this.getHorizontalHeading(this._dir);
      this.rig.position.addScaledVector(this._dir, speed * dt);
      this.state.forwardSpeed = speed;
    } else {
      this.forwardHeld = 0; // anında dur
      this.state.forwardSpeed = 0;
    }

    // --- Dönme --------------------------------------------------------------
    const dir = this.intent.rotation;
    if (dir !== 0) {
      if (dir !== this.lastTurnDir) this.turnHeld = 0; // yön değiştiyse rampa yeniden
      this.turnHeld += dt;
      const speedDeg = o.turnSpeedDeg * ease(this.turnHeld / o.rampTime);
      // Three.js sağ el kuralı: +Y etrafında pozitif açı = sola dönüş.
      const angle = -dir * THREE.MathUtils.degToRad(speedDeg) * dt;
      this.rotateAroundHead(angle);
      this.state.rotationSpeedDeg = dir * speedDeg;
    } else {
      this.turnHeld = 0;
      this.state.rotationSpeedDeg = 0;
    }
    this.lastTurnDir = dir;
  }

  /** Rig'i başın dünya pozisyonundan geçen dikey eksen etrafında döndürür. */
  rotateAroundHead(angle) {
    this.camera.updateMatrixWorld();
    this.camera.getWorldPosition(this._head);
    this._q.setFromAxisAngle(UP, angle);
    this.rig.position.sub(this._head).applyQuaternion(this._q).add(this._head);
    this.rig.quaternion.premultiply(this._q);
    this.rig.updateMatrixWorld();
  }

  /**
   * Başlangıç noktasına dön. XR'da kullanıcının fiziksel odadaki konumu
   * değiştirilemeyeceği için rig, BAŞ başlangıç noktasına gelecek şekilde
   * kaydırılır (kafanın yüksekliğine dokunulmaz).
   */
  reset({ alignHead = false } = {}) {
    this.stop();
    this.rig.position.copy(this.startPosition);
    this.rig.quaternion.copy(this.startQuaternion);
    if (alignHead) {
      const local = this.camera.position.clone();
      local.y = 0;
      local.applyQuaternion(this.rig.quaternion);
      this.rig.position.sub(local);
    }
    this.rig.updateMatrixWorld();
  }
}
