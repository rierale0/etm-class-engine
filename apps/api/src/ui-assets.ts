export const localAppHtml = String.raw`<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>ETM Class Engine</title>
    <link rel="stylesheet" href="/ui/app.css">
    <script src="/ui/app.js" defer></script>
  </head>
  <body>
    <main class="shell">
      <header class="hero">
        <div>
          <p class="eyebrow">LOCAL ANALYSIS WORKSPACE</p>
          <h1>ETM Class Engine</h1>
          <p class="subtitle">Procesa clases de YouTube desde tu conexión local y entrega el resultado a n8n.</p>
        </div>
        <div class="system-state"><span class="pulse"></span> Motor disponible</div>
      </header>

      <section class="panel submit-panel" aria-labelledby="new-analysis-title">
        <div class="section-heading">
          <div>
            <p class="step">01 · ENTRADA</p>
            <h2 id="new-analysis-title">Nueva clase</h2>
          </div>
          <button type="button" class="button secondary" id="add-video">+ Añadir video</button>
        </div>

        <form id="job-form">
          <div id="video-rows" class="video-rows"></div>
          <div class="form-footer">
            <p id="form-message" class="form-message" role="status"></p>
            <button type="submit" class="button primary" id="submit-jobs">Enviar a procesamiento</button>
          </div>
        </form>
      </section>

      <section class="panel jobs-panel" aria-labelledby="jobs-title">
        <div class="section-heading">
          <div>
            <p class="step">02 · PROCESAMIENTO</p>
            <h2 id="jobs-title">Trabajos recientes</h2>
          </div>
          <button type="button" class="button ghost" id="refresh-jobs">Actualizar</button>
        </div>
        <div id="jobs" class="jobs" aria-live="polite">
          <p class="empty">Cargando trabajos…</p>
        </div>
      </section>
    </main>

    <template id="video-row-template">
      <fieldset class="video-row">
        <div class="row-heading">
          <legend>Video <span class="row-number"></span></legend>
          <button type="button" class="remove-row" aria-label="Eliminar video">Eliminar</button>
        </div>
        <label class="field field-wide">
          <span>Enlace de YouTube</span>
          <input name="videoUrl" type="url" required placeholder="https://www.youtube.com/watch?v=…">
        </label>
        <label class="field">
          <span>Profesor</span>
          <input name="teacher" type="text" maxlength="200" required placeholder="Nombre del profesor">
        </label>
        <label class="field">
          <span>Fecha de la clase</span>
          <input name="classDate" type="date" required>
        </label>
        <label class="field">
          <span>Curso</span>
          <input name="course" type="text" maxlength="200" required placeholder="Workshops V8">
        </label>
        <label class="field">
          <span>Título</span>
          <input name="title" type="text" maxlength="300" required value="ETM English Class">
        </label>
        <label class="visual-toggle">
          <input name="analyzeVisuals" type="checkbox">
          <span class="toggle"></span>
          <span>
            <strong>Análisis visual</strong>
            <small>Extrae y analiza fotogramas relevantes</small>
          </span>
        </label>
      </fieldset>
    </template>

    <dialog id="result-dialog">
      <div class="dialog-heading">
        <div>
          <p class="step">RESULTADO JSON</p>
          <h2 id="dialog-title">Análisis</h2>
        </div>
        <button type="button" class="dialog-close" id="close-dialog" aria-label="Cerrar">×</button>
      </div>
      <pre id="result-json"></pre>
    </dialog>
  </body>
</html>`;

export const localAppCss = String.raw`:root {
  --bg: #090b0f;
  --surface: #11151b;
  --surface-2: #171c24;
  --line: #29313d;
  --text: #f4f7fb;
  --muted: #94a0af;
  --accent: #75f0b2;
  --accent-ink: #062417;
  --blue: #79a8ff;
  --danger: #ff8585;
  --warning: #ffc86b;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--text);
  background: var(--bg);
}

* { box-sizing: border-box; }
body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
  background:
    radial-gradient(circle at 15% 0%, rgba(117, 240, 178, .09), transparent 30rem),
    radial-gradient(circle at 85% 20%, rgba(121, 168, 255, .08), transparent 32rem),
    var(--bg);
}
button, input { font: inherit; }
button { cursor: pointer; }
.shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 72px; }
.hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 32px; }
.eyebrow, .step { margin: 0 0 8px; color: var(--accent); font-size: .72rem; font-weight: 800; letter-spacing: .16em; }
h1 { margin: 0; font-size: clamp(2.4rem, 6vw, 4.8rem); line-height: .98; letter-spacing: -.055em; }
h2 { margin: 0; font-size: 1.55rem; letter-spacing: -.025em; }
.subtitle { max-width: 660px; margin: 18px 0 0; color: var(--muted); font-size: 1.05rem; line-height: 1.65; }
.system-state { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: .82rem; white-space: nowrap; padding-top: 8px; }
.pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 6px rgba(117, 240, 178, .09); }
.panel { background: rgba(17, 21, 27, .92); border: 1px solid var(--line); border-radius: 18px; overflow: hidden; box-shadow: 0 24px 80px rgba(0,0,0,.22); }
.panel + .panel { margin-top: 24px; }
.section-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 24px 26px; border-bottom: 1px solid var(--line); }
.video-rows { display: grid; gap: 1px; background: var(--line); }
.video-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin: 0; padding: 26px; border: 0; background: var(--surface); }
.row-heading { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; }
.row-heading legend { padding: 0; font-weight: 750; }
.remove-row, .dialog-close { border: 0; color: var(--muted); background: transparent; }
.remove-row:hover, .dialog-close:hover { color: var(--danger); }
.field { display: grid; gap: 8px; color: var(--muted); font-size: .78rem; font-weight: 700; letter-spacing: .02em; }
.field-wide { grid-column: 1 / -1; }
.field input {
  width: 100%; border: 1px solid #303947; border-radius: 10px; outline: 0;
  background: #0d1015; color: var(--text); padding: 13px 14px; transition: border-color .15s, box-shadow .15s;
}
.field input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(117, 240, 178, .1); }
.visual-toggle { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px; color: var(--text); cursor: pointer; }
.visual-toggle input { position: absolute; opacity: 0; pointer-events: none; }
.toggle { width: 42px; height: 24px; flex: 0 0 auto; padding: 3px; border-radius: 999px; background: #323b48; transition: background .15s; }
.toggle::after { content: ""; display: block; width: 18px; height: 18px; border-radius: 50%; background: white; transition: transform .15s; }
.visual-toggle input:checked + .toggle { background: var(--accent); }
.visual-toggle input:checked + .toggle::after { transform: translateX(18px); }
.visual-toggle strong, .visual-toggle small { display: block; }
.visual-toggle small { margin-top: 2px; color: var(--muted); font-weight: 400; }
.form-footer { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 22px 26px; }
.form-message { margin: 0; color: var(--muted); font-size: .88rem; }
.form-message.error { color: var(--danger); }
.form-message.success { color: var(--accent); }
.button { border: 1px solid transparent; border-radius: 9px; padding: 10px 15px; font-size: .84rem; font-weight: 750; transition: transform .12s, background .12s, border-color .12s; }
.button:hover { transform: translateY(-1px); }
.button:disabled { opacity: .5; cursor: wait; transform: none; }
.primary { padding: 12px 18px; background: var(--accent); color: var(--accent-ink); }
.secondary { border-color: var(--line); background: var(--surface-2); color: var(--text); }
.ghost { border-color: var(--line); background: transparent; color: var(--muted); }
.jobs { min-height: 140px; }
.empty { margin: 0; padding: 52px 26px; text-align: center; color: var(--muted); }
.job { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(190px, .8fr) auto; gap: 24px; align-items: center; padding: 22px 26px; border-bottom: 1px solid var(--line); }
.job:last-child { border-bottom: 0; }
.job-title { margin: 0 0 7px; font-size: 1rem; }
.job-meta { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--muted); font-size: .78rem; }
.job-meta a { color: var(--blue); text-decoration: none; }
.status-row { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 8px; font-size: .76rem; color: var(--muted); }
.progress { appearance: none; display: block; width: 100%; height: 6px; overflow: hidden; border: 0; border-radius: 999px; background: #29303a; }
.progress::-webkit-progress-bar { border-radius: 999px; background: #29303a; }
.progress::-webkit-progress-value { border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--blue)); }
.progress::-moz-progress-bar { border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--blue)); }
.job-state .badge { margin-top: 10px; }
.badge { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 999px; padding: 4px 8px; font-size: .7rem; color: var(--muted); }
.badge.failed { border-color: rgba(255,133,133,.35); color: var(--danger); }
.badge.sent { border-color: rgba(117,240,178,.3); color: var(--accent); }
.job-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.small { padding: 7px 10px; font-size: .75rem; }
.job-error { margin: 9px 0 0; color: var(--danger); font-size: .78rem; }
dialog { width: min(980px, calc(100% - 32px)); max-height: calc(100vh - 48px); padding: 0; border: 1px solid var(--line); border-radius: 16px; color: var(--text); background: var(--surface); box-shadow: 0 30px 100px rgba(0,0,0,.65); }
dialog::backdrop { background: rgba(2,4,7,.78); backdrop-filter: blur(5px); }
.dialog-heading { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px; border-bottom: 1px solid var(--line); }
.dialog-close { font-size: 2rem; line-height: 1; }
#result-json { margin: 0; padding: 24px; max-height: 70vh; overflow: auto; color: #d8e5f5; background: #0b0e12; font: .77rem/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }

@media (max-width: 780px) {
  .shell { width: min(100% - 20px, 1180px); padding-top: 28px; }
  .hero { display: block; }
  .system-state { margin-top: 20px; }
  .video-row { grid-template-columns: 1fr; padding: 20px; }
  .field-wide, .visual-toggle, .row-heading { grid-column: 1; }
  .job { grid-template-columns: 1fr; gap: 16px; padding: 20px; }
  .job-actions { justify-content: flex-start; }
  .section-heading, .form-footer { align-items: flex-start; }
  .form-footer { flex-direction: column; }
  .primary { width: 100%; }
}`;

export const localAppJavaScript = String.raw`(() => {
  const rows = document.querySelector('#video-rows');
  const template = document.querySelector('#video-row-template');
  const form = document.querySelector('#job-form');
  const message = document.querySelector('#form-message');
  const submitButton = document.querySelector('#submit-jobs');
  const jobsContainer = document.querySelector('#jobs');
  const dialog = document.querySelector('#result-dialog');
  const resultJson = document.querySelector('#result-json');
  const dialogTitle = document.querySelector('#dialog-title');
  let visualAnalysisEnabled = false;

  const stages = {
    queued: 'En cola',
    validating_video: 'Validando video',
    downloading: 'Descargando',
    extracting_audio: 'Extrayendo audio',
    transcribing: 'Transcribiendo',
    extracting_frames: 'Extrayendo fotogramas',
    analyzing_visuals: 'Analizando imágenes',
    synthesizing: 'Construyendo análisis',
    sending_callback: 'Enviando a n8n',
    completed: 'Completado',
    failed: 'Fallido'
  };

  function addRow(copyPrevious) {
    const fragment = template.content.cloneNode(true);
    const row = fragment.querySelector('.video-row');
    const previous = rows.lastElementChild;
    if (copyPrevious && previous) {
      ['teacher', 'classDate', 'course', 'title'].forEach((name) => {
        row.querySelector('[name="' + name + '"]').value = previous.querySelector('[name="' + name + '"]').value;
      });
      row.querySelector('[name="analyzeVisuals"]').checked = previous.querySelector('[name="analyzeVisuals"]').checked;
    }
    row.querySelector('.remove-row').addEventListener('click', () => {
      row.remove();
      numberRows();
    });
    syncVisualControl(row);
    rows.appendChild(fragment);
    numberRows();
  }

  function syncVisualControl(row) {
    const input = row.querySelector('[name="analyzeVisuals"]');
    const description = row.querySelector('.visual-toggle small');
    input.disabled = !visualAnalysisEnabled;
    if (!visualAnalysisEnabled) input.checked = false;
    description.textContent = visualAnalysisEnabled
      ? 'Extrae y analiza fotogramas relevantes'
      : 'Actívalo en .env con ENABLE_VISUAL_ANALYSIS=true';
  }

  async function loadCapabilities() {
    try {
      const response = await fetch('/ui/config', { cache: 'no-store' });
      if (!response.ok) return;
      const capabilities = await response.json();
      visualAnalysisEnabled = capabilities.visualAnalysisEnabled === true;
      rows.querySelectorAll('.video-row').forEach(syncVisualControl);
    } catch {
      visualAnalysisEnabled = false;
    }
  }

  function numberRows() {
    const current = [...rows.querySelectorAll('.video-row')];
    current.forEach((row, index) => {
      row.querySelector('.row-number').textContent = String(index + 1);
      row.querySelector('.remove-row').hidden = current.length === 1;
    });
  }

  function payloadFor(row) {
    return {
      videoUrl: row.querySelector('[name="videoUrl"]').value.trim(),
      teacher: row.querySelector('[name="teacher"]').value.trim(),
      classDate: row.querySelector('[name="classDate"]').value,
      course: row.querySelector('[name="course"]').value.trim(),
      title: row.querySelector('[name="title"]').value.trim(),
      analyzeVisuals: row.querySelector('[name="analyzeVisuals"]').checked
    };
  }

  async function submitJob(payload) {
    const response = await fetch('/ui/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || 'No se pudo crear el trabajo');
    return body;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    submitButton.disabled = true;
    message.className = 'form-message';
    message.textContent = 'Creando trabajos…';
    try {
      const payloads = [...rows.querySelectorAll('.video-row')].map(payloadFor);
      const results = await Promise.allSettled(payloads.map(submitJob));
      const created = results.filter((result) => result.status === 'fulfilled').length;
      const errors = results.filter((result) => result.status === 'rejected');
      if (errors.length) {
        message.className = 'form-message error';
        message.textContent = created + ' creado(s). ' + errors.map((error) => error.reason.message).join(' · ');
      } else {
        message.className = 'form-message success';
        message.textContent = created + (created === 1 ? ' trabajo enviado.' : ' trabajos enviados.');
        [...rows.querySelectorAll('[name="videoUrl"]')].forEach((input) => { input.value = ''; });
      }
      await loadJobs();
    } catch (error) {
      message.className = 'form-message error';
      message.textContent = error.message;
    } finally {
      submitButton.disabled = false;
    }
  });

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function actionButton(label, handler, className) {
    const button = node('button', 'button small ' + (className || 'ghost'), label);
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
  }

  function renderJob(job) {
    const article = node('article', 'job');
    const identity = node('div', 'job-identity');
    identity.appendChild(node('h3', 'job-title', job.request?.title || 'Clase de inglés'));
    const meta = node('div', 'job-meta');
    const link = node('a', '', job.videoId);
    link.href = job.videoUrl;
    link.target = '_blank';
    link.rel = 'noreferrer';
    meta.append(link);
    if (job.request?.teacher) meta.append(node('span', '', job.request.teacher));
    if (job.request?.course) meta.append(node('span', '', job.request.course));
    if (job.request?.classDate) meta.append(node('span', '', job.request.classDate));
    identity.append(meta);
    if (job.error) identity.append(node('p', 'job-error', job.error.message));

    const state = node('div', 'job-state');
    const statusRow = node('div', 'status-row');
    statusRow.append(node('span', '', stages[job.status] || job.status));
    statusRow.append(node('span', '', String(job.progress) + '%'));
    state.append(statusRow);
    const progress = node('progress', 'progress');
    progress.max = 100;
    progress.value = job.progress;
    state.append(progress);
    const callbackBadge = node('span', 'badge ' + job.callback.status, 'n8n · ' + job.callback.status);
    callbackBadge.title = job.callback.lastError || '';
    state.append(callbackBadge);

    const actions = node('div', 'job-actions');
    if (job.resultAvailable) {
      actions.append(actionButton('Ver resultado', () => showResult(job.jobId), 'secondary'));
      const download = node('a', 'button small ghost', 'Descargar JSON');
      download.href = '/ui/jobs/' + job.jobId + '/result';
      actions.append(download);
    }
    if (job.callback.status === 'failed') {
      actions.append(actionButton('Reenviar a n8n', () => retryCallback(job.jobId), 'ghost'));
    }

    article.append(identity, state, actions);
    return article;
  }

  async function loadJobs() {
    try {
      const response = await fetch('/ui/jobs?limit=30', { cache: 'no-store' });
      if (!response.ok) throw new Error('No se pudo cargar el historial');
      const body = await response.json();
      jobsContainer.replaceChildren();
      if (!body.jobs.length) {
        jobsContainer.append(node('p', 'empty', 'Aún no hay trabajos. Envía tu primera clase.'));
        return;
      }
      body.jobs.forEach((job) => jobsContainer.append(renderJob(job)));
    } catch (error) {
      jobsContainer.replaceChildren(node('p', 'empty', error.message));
    }
  }

  async function showResult(jobId) {
    const response = await fetch('/ui/jobs/' + jobId, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) return;
    dialogTitle.textContent = body.request?.title || body.videoId;
    resultJson.textContent = JSON.stringify(body.analysis, null, 2);
    dialog.showModal();
  }

  async function retryCallback(jobId) {
    const response = await fetch('/ui/jobs/' + jobId + '/retry-callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    if (!response.ok) {
      const body = await response.json();
      message.className = 'form-message error';
      message.textContent = body.message || 'No se pudo reenviar el webhook';
    }
    await loadJobs();
  }

  document.querySelector('#add-video').addEventListener('click', () => addRow(true));
  document.querySelector('#refresh-jobs').addEventListener('click', loadJobs);
  document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  addRow(false);
  loadCapabilities();
  loadJobs();
  window.setInterval(loadJobs, 4000);
})();`;
