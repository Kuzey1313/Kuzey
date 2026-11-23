/**
 * xr-manager.js — immersive-vr oturum yaşam döngüsü.
 *
 *  - navigator.xr desteğini kontrol eder ve Enter VR butonunu yönetir.
 *  - Oturumu optionalFeatures: ['local-floor', 'hand-tracking'] ile ister.
 *  - Referans alanı: önce 'local-floor'; desteklenmezse 'local' + tahmini
 *    zemin ofseti (yalnızca ORİJİN kaydırılır, baş takibi aynen korunur).
 *  - Oturum bittiğinde masaüstü moduna temiz dönüş için olay yayar.
 *
 * Olaylar (EventTarget): 'statechange', 'sessionstart', 'sessionend', 'inputchange'
 */

export const XR_STATE = Object.freeze({
  CHECKING: 'checking',
  UNSUPPORTED: 'unsupported',
  READY: 'ready',
  REQUESTING: 'requesting',
  ACTIVE: 'active',
  ERROR: 'error',
});

const STATE_LABEL = {
  checking: 'Kontrol ediliyor…',
  unsupported: 'Desteklenmiyor',
  ready: 'Hazır (oturum yok)',
  requesting: 'Oturum isteniyor…',
  active: 'Aktif (immersive-vr)',
  error: 'Hata',
};

/** 'local' fallback'inde zeminin baş başlangıcına göre tahmini derinliği (m). */
const FALLBACK_FLOOR_OFFSET = 1.6;

export class XRManager extends EventTarget {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {HTMLButtonElement} button
   */
  constructor(renderer, button) {
    super();
    this.renderer = renderer;
    this.button = button;
    this.session = null;
    this.state = XR_STATE.CHECKING;
    this.message = '';
    this.referenceSpaceType = null;
    /** true / false / null (tarayıcı enabledFeatures bildirmiyorsa bilinmiyor) */
    this.handTrackingEnabled = null;
    this.inputs = { hands: 0, controllers: 0 };

    this._onEnd = this._onEnd.bind(this);
    this._onInputSourcesChange = this._onInputSourcesChange.bind(this);
    this.button.addEventListener('click', () => this.toggle());
  }

  get stateLabel() {
    return STATE_LABEL[this.state] ?? this.state;
  }

  async init() {
    this._setState(XR_STATE.CHECKING);
    if (!window.isSecureContext) {
      this._unsupported('WebXR yalnızca HTTPS (veya localhost) üzerinde çalışır.');
      return;
    }
    if (!('xr' in navigator)) {
      this._unsupported('Bu tarayıcı WebXR desteklemiyor. Quest 3 Browser ile açın.');
      return;
    }
    try {
      const ok = await navigator.xr.isSessionSupported('immersive-vr');
      if (!ok) {
        this._unsupported('immersive-vr bu cihazda desteklenmiyor (masaüstü modu kullanılabilir).');
        return;
      }
      this._setState(XR_STATE.READY);
    } catch (err) {
      this._unsupported(`WebXR kontrolü başarısız: ${err.message}`);
    }
  }

  async toggle() {
    if (this.session) {
      await this.end();
    } else {
      await this.start();
    }
  }

  async start() {
    if (this.state !== XR_STATE.READY && this.state !== XR_STATE.ERROR) return;
    this._setState(XR_STATE.REQUESTING);
    let session;
    try {
      // Not: Kullanıcı tıklamasının hemen ardından çağrılmalı (user activation).
      session = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'hand-tracking'],
      });
    } catch (err) {
      this._setState(XR_STATE.ERROR, `VR oturumu başlatılamadı: ${err.message}`);
      return;
    }

    try {
      // Referans alanı seçimi + fallback
      let fallbackSpace = null;
      try {
        await session.requestReferenceSpace('local-floor');
        this.referenceSpaceType = 'local-floor';
      } catch {
        this.referenceSpaceType = 'local';
      }
      this.renderer.xr.setReferenceSpaceType(this.referenceSpaceType);
      await this.renderer.xr.setSession(session);

      if (this.referenceSpaceType === 'local') {
        // 'local' orijini başın ilk konumundadır. Zemini y=0'a taşımak için
        // orijini aşağı kaydırıyoruz. Bu bir koordinat ofsetidir; baş takibi
        // (yükseklik dahil) her karede WebXR'dan gelmeye devam eder.
        const local = await session.requestReferenceSpace('local');
        fallbackSpace = local.getOffsetReferenceSpace(
          new XRRigidTransform({ x: 0, y: -FALLBACK_FLOOR_OFFSET, z: 0 }),
        );
        this.renderer.xr.setReferenceSpace(fallbackSpace);
        this.referenceSpaceType = 'local (+zemin ofseti)';
      }

      this.session = session;
      this.handTrackingEnabled = Array.isArray(session.enabledFeatures)
        ? session.enabledFeatures.includes('hand-tracking')
        : null;

      session.addEventListener('end', this._onEnd);
      session.addEventListener('inputsourceschange', this._onInputSourcesChange);
      this._countInputs();

      let msg = '';
      if (this.handTrackingEnabled === false) {
        msg = 'Hand tracking bu oturumda etkin değil. Quest ayarlarından "El ve vücut takibi"ni açın.';
      }
      this._setState(XR_STATE.ACTIVE, msg);
      this.dispatchEvent(new CustomEvent('sessionstart', { detail: { session } }));
    } catch (err) {
      this._setState(XR_STATE.ERROR, `XR kurulumu başarısız: ${err.message}`);
      try { await session.end(); } catch { /* zaten kapalı */ }
    }
  }

  async end() {
    if (!this.session) return;
    try {
      await this.session.end(); // 'end' olayı _onEnd'i tetikler
    } catch {
      this._onEnd();
    }
  }

  _onEnd() {
    if (this.session) {
      this.session.removeEventListener('end', this._onEnd);
      this.session.removeEventListener('inputsourceschange', this._onInputSourcesChange);
    }
    this.session = null;
    this.handTrackingEnabled = null;
    this.referenceSpaceType = null;
    this.inputs = { hands: 0, controllers: 0 };
    this._setState(XR_STATE.READY, 'VR oturumu kapatıldı.');
    this.dispatchEvent(new CustomEvent('sessionend'));
  }

  _onInputSourcesChange() {
    this._countInputs();
    this.dispatchEvent(new CustomEvent('inputchange', { detail: { ...this.inputs } }));
  }

  _countInputs() {
    let hands = 0;
    let controllers = 0;
    if (this.session) {
      for (const src of this.session.inputSources) {
        if (src.hand) hands++;
        else if (src.gamepad || src.targetRayMode === 'tracked-pointer') controllers++;
      }
    }
    this.inputs = { hands, controllers };
  }

  _unsupported(message) {
    this._setState(XR_STATE.UNSUPPORTED, message);
  }

  _setState(state, message = '') {
    this.state = state;
    this.message = message;
    const b = this.button;
    switch (state) {
      case XR_STATE.CHECKING:
        b.disabled = true; b.textContent = 'VR kontrol ediliyor…'; break;
      case XR_STATE.UNSUPPORTED:
        b.disabled = true; b.textContent = 'VR desteklenmiyor'; break;
      case XR_STATE.READY:
      case XR_STATE.ERROR:
        b.disabled = false; b.textContent = 'Enter VR'; break;
      case XR_STATE.REQUESTING:
        b.disabled = true; b.textContent = 'Başlatılıyor…'; break;
      case XR_STATE.ACTIVE:
        b.disabled = false; b.textContent = 'Exit VR'; break;
      default: break;
    }
    b.dataset.state = state;
    this.dispatchEvent(new CustomEvent('statechange', { detail: { state, message } }));
  }
}
