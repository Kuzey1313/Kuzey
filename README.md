# WebXR Quest 3: El Hareketiyle Gezinme (1:70 Ölçek)

Meta Quest 3 Browser'da **Enter VR** ile açılan ve kontrolcü kullanmadan, yalnızca el
hareketleriyle (pinch) gezilen bir WebXR deneyimi. Kullanıcı 1:70 ölçekli bir mimari
maketin içinde insan gözü perspektifinden dolaşır. Masaüstü tarayıcıda aynı kontroller
webcam ve MediaPipe Hand Landmarker ile çalışır.

Statik dosyalardan oluşur. Backend, Node sunucusu veya build adımı gerekmez. Kütüphaneler
sabit sürümlü CDN adreslerinden (import map) yüklenir.

| Kütüphane | Sürüm | Kaynak |
|---|---|---|
| three.js | 0.170.0 | cdn.jsdelivr.net/npm/three@0.170.0 |
| @mediapipe/tasks-vision | 0.10.14 | cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14 |
| Hand Landmarker modeli | float16/1 | storage.googleapis.com/mediapipe-models |

---

## Kontroller

| El hareketi | Fonksiyon |
|---|---|
| Başparmak + işaret parmağı pinch | İleri yürü (başın baktığı yatay yönde) |
| Başparmak + serçe parmak pinch | Sağa dön (dünya Y ekseni) |
| Başparmak + yüzük parmağı pinch | Sola dön (dünya Y ekseni) |
| Pinch yok / el görünmüyor | Dur |

İki el de takip edilir. Bir el yürürken diğeri döndürebilir. İki el zıt yönlere dönmek
isterse dönüş iptal edilir.

Masaüstünde test kolaylığı için ek debug kontrolleri vardır: fareyle sürükleyerek bakış,
**W / A / D** veya ok tuşları. Bunlar aynı locomotion sistemine bağlıdır ve VR'da devre dışıdır.

---

## Dosya yapısı

```text
webxr-quest3/
├── index.html            Arayüz + import map
├── css/style.css
├── js/
│   ├── main.js           Uygulama kurulumu, tek render döngüsü, UI, VR HUD
│   ├── xr-manager.js     immersive-vr oturumu, referans alanı fallback'i, yaşam döngüsü
│   ├── hand-tracking.js  Quest 3 WebXR eklem verisi (XRFrame.getJointPose)
│   ├── gestures.js       Ortak jest motoru (bağımlılıksız, test edilebilir)
│   ├── locomotion.js     Frame-rate bağımsız yürüme/dönme
│   ├── desktop-hands.js  Webcam + MediaPipe Hand Landmarker
│   └── scene.js          1:70 ölçek sistemi, örnek maket, GLB/GLTF yükleyici
├── assets/models/        Kendi .glb/.gltf modelleriniz
├── tests/gestures.test.mjs
├── package.json          Yalnızca `npm test` için. Bağımlılık yok.
├── .nojekyll
└── README.md
```

`scene.js` istenen yapıya eklenmiş tek ek modüldür. Ölçek sistemi ile sahne/model
yükleme kodunu `main.js` dışında, ayrı ve yeniden kullanılabilir tutar.

---

## Mimari: iki takip sistemi, tek gesture engine

```
Quest 3: XRFrame.getJointPose()  ──┐   ortak format:
                                   ├─► { id, handedness, points:{wrist, thumbTip, indexTip,
Masaüstü: MediaPipe worldLandmarks ┘        middleTip, ringTip, pinkyTip, middleMcp} }
                                                     │
                                              GestureEngine (gestures.js)
                                                     │  { forward, rotation: -1|0|1 }
                                              Locomotion (locomotion.js)
                                                     │
                                              rig (kamera + ellerin ebeveyni)
```

Sahne hiyerarşisi:

```
scene
 ├─ modelRoot          scale = viewScale (70); içerik MAKET biriminde
 │   └─ örnek maket / yüklenen GLB
 └─ rig                tracking space'in dünyadaki yeri, ölçeği HER ZAMAN 1
     ├─ camera         pozu her karede WebXR'dan gelir (masaüstünde y = 1.60 m)
     │   └─ HUD        VR durum göstergesi
     └─ hand[0], hand[1]
```

Locomotion yalnızca `rig`'in pozisyonunu ve rotasyonunu değiştirir. Kameraya veya baş
pozuna hiçbir zaman yazmaz.

---

## 1:70 ölçek: kullanılan yöntem

### Dört ayrı kavram

| Kavram | Birim | Örnek |
|---|---|---|
| Gerçek bina ölçüsü | tasarım metresi | duvar 3.00 m |
| Maket ölçüsü ("model birimi") | gerçek / 70 | duvar 0.04286 m |
| Tracking space (WebXR) | daima gerçek metre | baş 1.60 m, el pozları |
| Görüntü ölçeği `s` (viewScale) | maket kökünün çarpanı | insan perspektifinde 70 |

Sabitler (`scene.js → SCALE`):

- Ölçek oranı: `1 / 70`
- Referans insan boyu: 1.70 m
- Referans göz yüksekliği: 1.60 m
- Ölçeklenmiş göz yüksekliği: `1.60 / 70 ≈ 0.02286` maket birimi (1 birim = 1 m)

### Dönüşümler

Maket içindeki bir nokta `p_m`, dünyaya şöyle yerleştirilir:

```
p_world = s · p_m            (s = 70 → p_world = gerçek bina metresi)
```

WebXR'ın verdiği baş pozu `h_t` (tracking space, metre) dünyaya yalnızca rig'in katı
dönüşümüyle (dönme + öteleme, ölçek yok) taşınır:

```
h_world = R_rig · h_t + T_rig
```

Başın maket koordinatı bu ikisinin birleşimidir:

```
h_m = (R_rig · h_t + T_rig) / s
```

Bu yöntemin sonuçları:

- **Göz yüksekliği zorlanmaz, türetilir.** Quest `local-floor` ile gerçek baş yüksekliğini
  verir (ör. 1.60 m). Bu değer maket içinde `1.60 / 70 = 0.02286` birim olur. Kullanıcı
  eğilirse veya otururursa yükseklik de buna göre değişir. Debug panelindeki "Göz yüksekliği"
  satırı bu değeri hem bina metresi hem maket birimi olarak gösterir.
- **Fiziksel hareket tutarlıdır.** 1 m fiziksel adım maket içinde 1/70 m (1.43 cm)
  ilerletir. Bu da gerçek binada 1 m demektir.
- **Stereo algı doğru kalır.** Gözler arası mesafe (~63 mm) maket içinde 0.9 mm'ye karşılık
  gelir. Bu, maketin içinde gerçekten 1:70 boyutunda bir insanın göreceği derinlik
  algısıdır. Bina "oyuncak" gibi değil, gerçek boyutunda algılanır.

### Neden baş pozu 1/70 ile çarpılmadı?

Dünyayı 70 kat büyütmek ile kullanıcıyı (kamera, göz arası mesafe ve baş hareketi
birlikte) 70 kat küçültmek matematiksel olarak eşdeğerdir. Ancak yalnızca baş pozunu 1/70
ile çarpmak bu üç bileşeni birbirinden koparır: göz arası mesafe ve projeksiyon gerçek
kalırken baş hareketi 70 kat küçülür. Sonuçta maket oyuncak gibi görünür ve baş hareketi ile
görüntü uyumsuzlaşır, bu da mide bulantısı yapar. Burada tek tutarlı dönüşüm olarak ölçek
**maket köküne** (`modelRoot.scale = 70`) uygulanır. Tracking space'e ve rig'e hiçbir ölçek
uygulanmaz. Bu aynı zamanda kamera `near` değerinin (0.01 m) ve derinlik hassasiyetinin
gerçek ölçekte kalmasını sağlar.

### Hız ve jestler

- Yürüme hızı tracking-space birimiyle tanımlanır: 1.3 m/s. Bu insan perspektifinde 1.3 m/s
  bina, yani 1.86 cm/s maket hızıdır. Debug panelinde üçü birlikte gösterilir.
- Jest eşikleri el uzayında, el büyüklüğüne göre normalize edilerek hesaplanır. Bu yüzden
  maket ölçeğinden tamamen bağımsızdır.

### Maket görünümü

"Görünüm" menüsünden **maket görünümü** seçildiğinde `s = 1` olur ve maketi masadaki
fiziksel boyutunda (≈ 20 × 14 cm) görürsünüz. Mod değişirken rig, maket içindeki aynı
noktada kalacak şekilde `k = s_yeni / s_eski` ile yeniden konumlandırılır.

---

## Jest algılama matematiği (`gestures.js`)

1. **Normalize mesafe:** `d_f = |thumbTip − fingerTip| / |wrist − middleMcp|`.
   `middleMcp`, WebXR'da `middle-finger-phalanx-proximal`, MediaPipe'ta landmark 9'dur.
   İkisi de orta parmağın kök (MCP) eklemidir.
2. **Hysteresis** (parmak başına): `d < press` ise basılı, `d > release` ise bırakıldı.
   Varsayılan değerler: işaret 0.25 / 0.38, yüzük ve serçe 0.30 / 0.44. Yetişkin elinde
   0.25 yaklaşık 2.4 cm'ye karşılık gelir.
3. **Kilitleme:** Seçilen jest, o parmak bırakılana kadar değişmez. Yüzük pinch'i sırasında
   serçe parmak da yaklaşırsa dönüş yönü aniden değişmez.
4. **Seçim ve öncelik:** Basılı parmaklar mesafeye göre sıralanır.
   - En yakın iki parmak arasındaki fark `ambiguityMargin` (0.06) değerinden büyükse en
     yakın olan seçilir.
   - Fark daha küçükse öncelik sırası uygulanır: ileri > sağ > sol.
   - Belirsizlik yalnızca zıt iki dönüş arasındaysa (yüzük ve serçe) **hiç hareket
     üretilmez**.
5. **Orta parmak koruması:** Başparmak–orta parmak mesafesi, adaydan belirgin şekilde
   küçükse kullanıcı aslında orta parmakla pinch yapıyordur ve jest seçilmez.
6. **Takip kaybı:** El kaybolursa veya veri geçersizse (NaN, sıfır el büyüklüğü) o elin
   durumu silinir. Hareket aynı karede durur.

Eşikler başlangıç değerleridir. Gerçek cihazda ayar gerekirse `DEFAULT_CONFIG` içinden
değiştirilebilir. Debug panelindeki "Normalize mesafe" satırı (İ/Y/S) ayar için canlı
değerleri gösterir.

---

## Yerelde çalıştırma

ES Module'ler `file://` üzerinden çalışmaz. Bu yüzden basit bir statik sunucu kullanın:

```bash
cd webxr-quest3
python3 -m http.server 8000
# → http://localhost:8000
```

`localhost` güvenli bağlam sayılır, yani kamera ve WebXR (emülatörle) çalışır. Masaüstünde
VR'ı denemek için Chrome'da **Immersive Web Emulator** eklentisi kullanılabilir.

### Testler

Bağımlılık yoktur. Node 18+ yeterlidir:

```bash
npm test
# veya: node --test tests/gestures.test.mjs
```

23 test şunları kapsar: normalize mesafe, üç jest, hysteresis, anında durma, el büyüklüğü
bağımsızlığı, kilitleme, öncelik ve belirsizlik kuralları, orta parmak koruması, geçersiz
veri, iki elli birleştirme ve çakışma, el kaybında sıfırlama, ayrıca MediaPipe sonucunun
ortak formata dönüşümü (el etiketinin çevrilmesi dahil).

---

## GitHub Pages'te yayınlama

1. GitHub'da yeni bir depo oluşturun (ör. `webxr-quest3`).
2. Bu klasörün **içeriğini** deponun köküne yükleyin. `index.html` kökte olmalıdır.
   ```bash
   git init && git add . && git commit -m "WebXR Quest 3 hand locomotion"
   git branch -M main
   git remote add origin https://github.com/KULLANICI/webxr-quest3.git
   git push -u origin main
   ```
3. Depo **Settings → Pages → Build and deployment**: Source **Deploy from a branch**,
   Branch **main**, klasör **/ (root)** → Save.
4. Birkaç dakika sonra site `https://KULLANICI.github.io/webxr-quest3/` adresinde yayında
   olur.

Tüm yerel yollar göreli olduğu için (`./css/…`, `./js/…`) proje bir alt dizinde de
çalışır. Örneğin klasörü olduğu gibi başka bir deponun içine koyarsanız adres
`…/repo/webxr-quest3/` olur. `.nojekyll` dosyası Jekyll işlemesini kapatır.

### Kendi mimari modelinizi yüklemek

`.glb` veya `.gltf` dosyasını `assets/models/` altına koyup URL parametresiyle açın:

```
…/index.html?model=assets/models/bina.glb&units=real
…/index.html?model=assets/models/maket.glb&units=maquette
```

- `units=real`: model gerçek bina ölçüsündedir (1 birim = 1 m). Yükleyici ×1/70 uygular.
  Varsayılan budur.
- `units=maquette`: model zaten 1:70 maket boyutundadır.

Modelin zemini y = 0'da olmalı. Kullanıcı (0, 0, 0) noktasında başlar ve −Z yönüne bakar.
Model yüklenemezse örnek sahne kalır ve bir hata mesajı gösterilir.

---

## Quest 3 test talimatları

1. **El takibini açın:** Quest Ayarlar → *Hareket takibi* → *El ve vücut takibi* açık.
   *Eller ile kontrolcüler arasında otomatik geçiş* de açık olsun.
2. Kontrolcüleri bırakın. Ellerinizi gösterdiğinizde sistem el moduna geçer.
3. Quest Browser'da GitHub Pages adresini açın (HTTPS şarttır).
4. **Enter VR** butonuna basın. İzin istenirse el takibine izin verin.
5. Görüşün alt kısmındaki küçük panelde (HUD) yeşil nokta el takibinin aktif olduğunu
   gösterir. **SOL / İLERİ / SAĞ** kutucukları da aktif hareketi gösterir.
6. Test edin:
   - Başparmak + işaret parmağı → ileri. Başınızı çevirip yürüyün: yön başınızı takip eder.
     Aşağı/yukarı bakmak hızı değiştirmez.
   - Başparmak + serçe parmak → sağa, başparmak + yüzük parmağı → sola dönüş.
   - Parmakları ayırın → hareket hemen durur.
   - Duvardaki "Ölçek 1:70" yazısı, 1.70 m insan figürleri, 10 m cetvel ve 1 m grid ile
     ölçeği kontrol edin.
7. Sistem menüsü veya **Exit VR** ile çıkın. Sayfa masaüstü moduna döner.

**Önemli: Meta sistem jesti.** Avuç içiniz başınıza dönükken başparmak + işaret pinch'i
Quest'in sistem menüsünü açar. Yürürken avuç içiniz aşağı veya ileri baksın.

Hand tracking oturumda etkin değilse veya birkaç saniye içinde el verisi gelmezse, HUD'da
kırmızı şerit ve sayfada uyarı görünür. Kontrolcü algılanırsa da uyarı verilir.

---

## Performans notları

- Statik mimari tek bir birleştirilmiş geometride toplanır (`mergeGeometries` + vertex
  color). Bu tek draw call demektir. Grid tek çizgi nesnesidir. Etiketler birkaç düzlemden
  oluşur.
- Gölge yok, `MeshLambertMaterial` kullanılır, `setFoveation(1)` açıktır.
- El modelleri `spheres` profilindedir (InstancedMesh, ağdan model indirmez).
- Eklem verisi her XR karesinde, önceden ayrılmış nesnelere okunur (GC baskısı yok).
- Masaüstü ve VR tek bir `renderer.setAnimationLoop()` döngüsündedir. VR başlarken webcam
  takibi tamamen kapatılır, böylece çakışma olmaz. Oturum bitince kamera, fov ve tuval boyutu
  geri yüklenir.
- `deltaTime` 0.1 s ile sınırlandırılır. Sekme değişiminden sonra ani sıçrama olmaz.

---

## Doğrulama durumu (dürüst not)

Bu projede **gerçekten çalıştırılanlar:**

- `npm test`: 23 birim testi geçti (gesture engine ve MediaPipe dönüştürücü).
- Tüm JS modülleri için `node --check` sözdizimi kontrolü yapıldı. Import map JSON'u
  doğrulandı.

**Henüz doğrulanmayanlar:**

- Gerçek bir **Meta Quest 3** cihazında çalıştırma (Enter VR, native hand tracking, HUD,
  eşiklerin uygunluğu).
- Tarayıcıda çalışma zamanı testi. Geliştirme ortamından CDN adreslerine erişilemediği için
  sayfa bir tarayıcıda açılıp konsol hataları kontrol edilemedi. CDN sürüm adresleri de
  oradan doğrulanamadı.
- MediaPipe ile webcam üzerinde canlı pinch algılama.

İlk gerçek testte özellikle şunlara bakın: tarayıcı konsolu, Quest'te eşiklerin rahatlığı
(debug panelindeki normalize mesafeler) ve `local-floor` sonrası göz yüksekliği satırı.
