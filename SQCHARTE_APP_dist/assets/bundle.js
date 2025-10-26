/* assets/bundle.js
   Escáner sonoro en tiempo real (vanilla JS)
   - Usa camera (facingMode: environment)
   - Analiza frames en canvas oculto
   - Mapea la sección horizontal detectada al tiempo del audio
   - Requiere interacción previa (clic en "ABRIR CÁMARA Y ESCANEAR")
*/

(() => {
  // ---------- CONFIG ----------
  const MP3_PATH = './assets/SQCHARTE-PaisajeSonoro.mp3';
  const SECTIONS = 12;              // cuántas columnas horizontales para mapear
  const SAMPLE_STEP = 6;            // revisar cada 6px para reducir CPU
  const DETECTION_THRESHOLD = 20;   // recuento mínimo por sección para considerarla "colorida"
  const TIME_SMOOTHING = 0.25;      // suavizado para evitar saltos brutales (0..1)
  const SEEK_EPS = 0.35;            // segundos mínimo de diferencia para saltar currentTime
  // -----------------------------

  // Root donde se injecta UI
  const root = document.getElementById('root');

  // Construir la UI (similar a tu diseño)
  root.innerHTML = `
    <div class="card">
      <h3 style="text-align:center;margin:0 0 12px;font-weight:900;color:#facc15">🎵 IMAGEN A ESCANEAR 🎵</h3>
      <div class="video-wrap" id="video-wrap">
        <div style="text-align:center;color:#9ca3af;padding:10px;">
          <svg width="320" height="160" viewBox="0 0 800 400" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="g1"><stop offset="0%" stop-color="#ef4444"/><stop offset="25%" stop-color="#eab308"/><stop offset="50%" stop-color="#22c55e"/><stop offset="75%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#ef4444"/></linearGradient>
              <linearGradient id="g2" x1="1" x2="0"><stop offset="0%" stop-color="#3b82f6"/><stop offset="25%" stop-color="#22c55e"/><stop offset="50%" stop-color="#eab308"/><stop offset="75%" stop-color="#ef4444"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient>
            </defs>
            <path d="M0 200 Q50 120 100 200 T200 200 T300 200 T400 200 T500 200 T600 200 T700 200 T800 200" stroke="url(#g1)" stroke-width="8" fill="none"/>
            <path d="M0 200 Q50 280 100 200 T200 200 T300 200 T400 200 T500 200 T600 200 T700 200 T800 200" stroke="url(#g2)" stroke-width="8" fill="none"/>
            <circle cx="100" cy="200" r="16" fill="#ef4444"/>
            <circle cx="300" cy="200" r="16" fill="#eab308"/>
            <circle cx="500" cy="200" r="16" fill="#22c55e"/>
            <circle cx="700" cy="200" r="16" fill="#3b82f6"/>
          </svg>
          <p style="margin:8px 0 0;color:#9ae6b4;font-weight:800">📸 Apunta con la cámara sobre esta imagen</p>
        </div>
        <!-- Aquí se inyecta el video -->
      </div>

      <div style="margin-top:12px;display:flex;gap:8px;">
        <button id="open-camera" class="btn btn-green">ABRIR CÁMARA</button>
        <button id="reset-scan" class="btn btn-red" style="display:none">ESCANEAR OTRA</button>
        <button id="show-instr" class="btn btn-blue" title="Instrucciones">?</button>
      </div>

      <div id="status" style="margin-top:12px;font-weight:800;text-align:center;color:#fbbf24"></div>
    </div>
  `;

  // Elements we need
  const videoWrap = document.getElementById('video-wrap');
  const openCameraBtn = document.getElementById('open-camera');
  const resetScanBtn = document.getElementById('reset-scan');
  const statusDiv = document.getElementById('status');

  // Create hidden video + canvas
  const video = document.createElement('video');
  video.setAttribute('playsinline', ''); // ios
  video.style.display = 'none';
  const canvas = document.createElement('canvas');
  canvas.style.display = 'none';
  const ctx = canvas.getContext('2d');

  // Append video to the wrap but keep hidden visually; we will show overlay if desired
  videoWrap.appendChild(video);
  document.body.appendChild(canvas);

  // Audio element
  const audio = new Audio(MP3_PATH);
  audio.volume = 0.85;
  audio.loop = false;

  // State
  let stream = null;
  let running = false;
  let lastSmoothedX = null;
  let lastDetection = false;
  let audioReady = false;
  let audioDuration = 0;

  // Preload audio metadata so we can map times
  audio.addEventListener('loadedmetadata', () => {
    audioDuration = audio.duration || 0;
    audioReady = true;
  });

  // Utility: map section index to percent (0..1)
  function indexToPercent(idx, sections) {
    return Math.min(1, Math.max(0, (idx + 0.5) / sections));
  }

  // Main analyze loop
  function analyzeLoop() {
    if (!running) return;
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      requestAnimationFrame(analyzeLoop);
      return;
    }

    const w = canvas.width = video.videoWidth;
    const h = canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const data = img.data;

    // Count colorful pixels per section
    const counts = new Array(SECTIONS).fill(0);
    const sectionW = Math.max(1, Math.floor(w / SECTIONS));

    for (let y = 0; y < h; y += SAMPLE_STEP) {
      for (let x = 0; x < w; x += SAMPLE_STEP) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        // Simple "colorful" test: saturation by difference from gray
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max - min;
        if (sat > 30 && max > 80) { // tuned threshold
          const sec = Math.min(SECTIONS - 1, Math.floor(x / sectionW));
          counts[sec]++;
        }
      }
    }

    // Find dominant section
    const maxCount = Math.max(...counts);
    const dominantIndex = counts.indexOf(maxCount);
    const detected = maxCount > DETECTION_THRESHOLD;

    // update status
    statusDiv.textContent = detected ? '✅ Imagen detectada' : '🔍 Buscando imagen...';

    // Compute percent and smoothing
    if (detected) {
      const targetPercent = indexToPercent(dominantIndex, SECTIONS);
      if (lastSmoothedX === null) lastSmoothedX = targetPercent;
      // exponential smoothing
      const smooth = (1 - TIME_SMOOTHING) * lastSmoothedX + TIME_SMOOTHING * targetPercent;
      lastSmoothedX = smooth;

      // Map to audio time if audio is ready
      if (audioReady && audioDuration > 0) {
        const targetTime = smooth * audioDuration;
        // Only seek if difference significant to avoid choppy tiny seeks
        if (Math.abs(audio.currentTime - targetTime) > SEEK_EPS) {
          // set currentTime (seek)
          try {
            audio.currentTime = targetTime;
          } catch (e) {
            // seeking can fail if not buffered; ignore
          }
        }
        // Ensure playing
        if (audio.paused) {
          audio.play().catch(() => {
            // play will fail without user interaction; but initial click has already happened
          });
        }
      }

      lastDetection = true;
    } else {
      // If not detected: optionally pause the audio but keep current time
      if (lastDetection && !audio.paused) {
        audio.pause();
      }
      lastDetection = false;
      lastSmoothedX = null;
    }

    requestAnimationFrame(analyzeLoop);
  }

  // Start camera stream
  async function startCamera() {
    try {
      statusDiv.textContent = '🔓 Solicitando cámara...';
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      video.srcObject = stream;
      await video.play();
      video.style.display = 'block';
      // Show a small visual (optional): we won't crop video; user points phone over printed image
      running = true;
      statusDiv.textContent = '🔄 Analizando...';
      analyzeLoop();
      openCameraBtn.style.display = 'none';
      resetScanBtn.style.display = 'inline-block';
    } catch (err) {
      console.error(err);
      alert('No fue posible acceder a la cámara. Verifica permisos o que el sitio esté en HTTPS.');
      statusDiv.textContent = '❌ Cámara no disponible';
    }
  }

  function stopCamera() {
    running = false;
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    video.srcObject = null;
    video.style.display = 'none';
    openCameraBtn.style.display = 'inline-block';
    resetScanBtn.style.display = 'none';
    statusDiv.textContent = '';
    // pause audio but keep time
    if (!audio.paused) audio.pause();
  }

  // Bind events
  openCameraBtn.addEventListener('click', async () => {
    // User interaction here enables audio playback in many browsers
    try {
      // Try to resume audio context by playing muted (some browsers require gesture)
      await audio.play().catch(() => {});
      // Immediately pause; we'll control playback in the loop
      if (!audio.paused) audio.pause();
    } catch (e) {
      // ignore
    }
    startCamera();
  });

  resetScanBtn.addEventListener('click', () => {
    stopCamera();
    // reset audio position? We keep the position as requested; you can choose to reset:
    // audio.currentTime = 0;
  });

  // Key safety: if user navigates away
  window.addEventListener('pagehide', () => {
    stopCamera();
  });

})();
