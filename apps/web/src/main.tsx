import { StrictMode, useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type AuthState = 'loading' | 'anonymous' | 'authenticated';
type VideoDraft = { id: string; source: string; title: string };
type Delivery = {
  status: 'not_sent' | 'sending' | 'accepted' | 'failed';
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
};
type Submission = {
  title: string;
  classDate: string;
  teacher: string;
  course: string;
  analyzeVisuals: boolean;
};
type Analysis = {
  summary?: string;
  estimated_level?: string;
  learning_objectives?: string[];
  key_concepts?: Array<{ concept: string; explanation: string; examples: string[] }>;
  vocabulary?: Array<{ term: string; meaning: string; example: string; timestamp: string }>;
  grammar?: Array<{ topic: string; explanation: string; examples: string[]; timestamp: string }>;
  student_difficulties?: string[];
  next_steps?: string[];
  transcript?: string;
  [key: string]: unknown;
};
type Job = {
  id: string;
  videoId: string;
  order: number;
  status: string;
  progress: number;
  submission: Submission | null;
  warnings: Array<{ code?: string; message?: string }>;
  error: { code: string; message: string } | null;
  analysis: Analysis | null;
  updatedAt: string;
};
type Batch = {
  id: string;
  name: string;
  status: 'processing' | 'attention' | 'ready';
  progress: number;
  counts: { total: number; completed: number; failed: number; active: number };
  delivery: Delivery;
  createdAt: string;
  updatedAt: string;
  jobs: Job[];
};
type CreateBatchInput = {
  name: string;
  course: string;
  teacher: string;
  classDate: string;
  analyzeVisuals: boolean;
  videos: Array<{ source: string; title: string }>;
};

const initialVideo = (index = 1): VideoDraft => ({
  id: crypto.randomUUID(),
  source: '',
  title: `Parte ${String(index)}`,
});

function App() {
  const [auth, setAuth] = useState<AuthState>('loading');
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);
  const [selectedAnalysis, setSelectedAnalysis] = useState<Job | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await api<{ batches: Batch[] }>('/ui-api/batches');
      setBatches(response.batches);
      if (selectedBatch) {
        const detail = await api<Batch>(`/ui-api/batches/${selectedBatch.id}`);
        setSelectedBatch(detail);
        if (selectedAnalysis)
          setSelectedAnalysis(detail.jobs.find((job) => job.id === selectedAnalysis.id) ?? null);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setAuth('anonymous');
      else setNotice({ kind: 'error', text: messageOf(error) });
    }
  }, [selectedAnalysis, selectedBatch]);

  useEffect(() => {
    void api('/ui-api/session')
      .then(() => {
        setAuth('authenticated');
      })
      .catch(() => {
        setAuth('anonymous');
      });
  }, []);

  useEffect(() => {
    if (auth !== 'authenticated') return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [auth, refresh]);

  async function login(password: string) {
    setBusy(true);
    try {
      await api('/ui-api/session', { method: 'POST', body: { password } });
      setAuth('authenticated');
      setNotice(null);
    } catch {
      setNotice({ kind: 'error', text: 'La contraseña no es correcta.' });
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api('/ui-api/session/logout', { method: 'POST' });
    setAuth('anonymous');
    setBatches([]);
    setSelectedBatch(null);
  }

  async function openBatch(id: string) {
    setBusy(true);
    try {
      setSelectedBatch(await api<Batch>(`/ui-api/batches/${id}`));
      window.setTimeout(() => document.getElementById('batch-detail')?.scrollIntoView(), 0);
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  }

  async function createBatch(input: CreateBatchInput) {
    setBusy(true);
    try {
      const created = await api<Batch>('/ui-api/batches', {
        method: 'POST',
        body: input,
        headers: { 'idempotency-key': crypto.randomUUID() },
      });
      setSelectedBatch(created);
      setNotice({ kind: 'success', text: `Lote “${created.name}” añadido a la cola.` });
      await refresh();
      window.setTimeout(() => document.getElementById('batch-detail')?.scrollIntoView(), 0);
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  }

  async function retryJob(jobId: string) {
    setBusy(true);
    try {
      await api(`/ui-api/jobs/${jobId}/retry`, { method: 'POST' });
      setNotice({ kind: 'success', text: 'El análisis volvió a la cola.' });
      await refresh();
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  }

  async function deliverBatch() {
    if (!selectedBatch) return;
    setBusy(true);
    try {
      const delivered = await api<Batch>(`/ui-api/batches/${selectedBatch.id}/deliver`, {
        method: 'POST',
      });
      setSelectedBatch(delivered);
      setNotice({ kind: 'success', text: 'n8n aceptó el lote para crear la lectura educativa.' });
      await refresh();
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  }

  if (auth === 'loading') return <LoadingScreen />;
  if (auth === 'anonymous') return <LoginScreen onLogin={login} busy={busy} notice={notice} />;

  return (
    <div className="app-shell">
      <Header onLogout={logout} />
      {notice && (
        <div className={`notice ${notice.kind}`} role="status">
          <span>{notice.text}</span>
          <button
            type="button"
            onClick={() => {
              setNotice(null);
            }}
            aria-label="Cerrar aviso"
          >
            ×
          </button>
        </div>
      )}
      <main id="top">
        <Hero batches={batches} />
        <BatchForm onSubmit={createBatch} busy={busy} />
        <BatchHistory batches={batches} onOpen={openBatch} />
        {selectedBatch && (
          <BatchDetail
            batch={selectedBatch}
            busy={busy}
            onRetry={retryJob}
            onDeliver={deliverBatch}
            onViewAnalysis={setSelectedAnalysis}
          />
        )}
      </main>
      {selectedAnalysis?.analysis && (
        <AnalysisPanel
          job={selectedAnalysis}
          onClose={() => {
            setSelectedAnalysis(null);
          }}
        />
      )}
    </div>
  );
}

function Header({ onLogout }: { onLogout: () => void }) {
  return (
    <header className="topbar">
      <a className="brand" href="#top" aria-label="ETM Class Engine, inicio">
        <span className="brand-mark">E</span>
        <span>
          <strong>ETM</strong>
          <small>CLASS ENGINE</small>
        </span>
      </a>
      <nav aria-label="Navegación principal">
        <a className="active" href="#batches">
          Lotes
        </a>
        <a href="#new-batch">Nuevo análisis</a>
      </nav>
      <div className="header-actions">
        <div className="system-state">
          <span /> Sistema listo
        </div>
        <button className="logout-button" type="button" onClick={onLogout}>
          Salir
        </button>
      </div>
    </header>
  );
}

function Hero({ batches }: { batches: Batch[] }) {
  const total = batches.reduce((sum, batch) => sum + batch.counts.completed, 0);
  const active = batches.filter((batch) => batch.status === 'processing').length;
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div>
        <p className="eyebrow">PANEL DE PRODUCCIÓN</p>
        <h1 id="hero-title">Convierte tus clases en material que enseña.</h1>
        <p className="hero-copy">
          Agrupa grabaciones, sigue cada análisis y entrega una unidad educativa completa a n8n.
        </p>
      </div>
      <div className="hero-stats" aria-label="Resumen del sistema">
        <div>
          <span>{String(total).padStart(2, '0')}</span>
          <small>Clases procesadas</small>
        </div>
        <div>
          <span>{String(active).padStart(2, '0')}</span>
          <small>Lotes activos</small>
        </div>
        <div>
          <span>100%</span>
          <small>Servicios disponibles</small>
        </div>
      </div>
    </section>
  );
}

function BatchForm({
  onSubmit,
  busy,
}: {
  onSubmit: (input: CreateBatchInput) => Promise<void>;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [course, setCourse] = useState('ETM English');
  const [teacher, setTeacher] = useState('');
  const [classDate, setClassDate] = useState(new Date().toISOString().slice(0, 10));
  const [analyzeVisuals, setAnalyzeVisuals] = useState(false);
  const [videos, setVideos] = useState<VideoDraft[]>([initialVideo()]);
  const readyCount = videos.filter((video) => video.source.trim() && video.title.trim()).length;
  const updateVideo = (id: string, field: 'source' | 'title', value: string) => {
    setVideos((current) =>
      current.map((video) => (video.id === id ? { ...video, [field]: value } : video)),
    );
  };
  function pasteMany(event: React.ClipboardEvent<HTMLInputElement>, targetId: string) {
    const lines = event.clipboardData
      .getData('text')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) return;
    event.preventDefault();
    setVideos((current) => {
      const targetIndex = current.findIndex((video) => video.id === targetId);
      return [
        ...current.slice(0, targetIndex),
        ...lines.map((source, index) => ({
          id: crypto.randomUUID(),
          source,
          title: `Parte ${String(targetIndex + index + 1)}`,
        })),
        ...current.slice(targetIndex + 1),
      ].slice(0, 50);
    });
  }
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const usable = videos.filter((video) => video.source.trim() && video.title.trim());
    if (!name.trim() || !teacher.trim() || !course.trim() || usable.length === 0) return;
    await onSubmit({
      name: name.trim(),
      teacher: teacher.trim(),
      course: course.trim(),
      classDate,
      analyzeVisuals,
      videos: usable.map(({ source, title }) => ({ source: source.trim(), title: title.trim() })),
    });
    setName('');
    setVideos([initialVideo()]);
  }
  return (
    <section className="workspace" id="new-batch">
      <div className="section-heading">
        <div>
          <p className="eyebrow">NUEVO LOTE</p>
          <h2>Prepara una unidad educativa</h2>
        </div>
        <span className="step-label">01 — CONFIGURACIÓN</span>
      </div>
      <form className="batch-form" onSubmit={submit}>
        <div className="form-grid">
          <label>
            <span>Nombre del lote</span>
            <input
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              placeholder="Ej. Conversation Club · Agosto"
            />
          </label>
          <label>
            <span>Curso</span>
            <input
              required
              value={course}
              onChange={(e) => {
                setCourse(e.target.value);
              }}
            />
          </label>
          <label>
            <span>Profesor</span>
            <input
              required
              value={teacher}
              onChange={(e) => {
                setTeacher(e.target.value);
              }}
              placeholder="Nombre del profesor"
            />
          </label>
          <label>
            <span>Fecha de clase</span>
            <input
              required
              type="date"
              value={classDate}
              onChange={(e) => {
                setClassDate(e.target.value);
              }}
            />
          </label>
        </div>
        <div className="video-builder">
          <div className="video-heading">
            <div>
              <h3>Vídeos del lote</h3>
              <p>Pega una o varias líneas con IDs o enlaces. El orden se conservará en n8n.</p>
            </div>
            <span>{String(videos.length).padStart(2, '0')} VÍDEOS</span>
          </div>
          <div className="video-list">
            {videos.map((video, index) => (
              <div className="video-row" key={video.id}>
                <span className="video-index">{String(index + 1).padStart(2, '0')}</span>
                <label>
                  <span>URL o ID de YouTube</span>
                  <input
                    required
                    value={video.source}
                    onPaste={(e) => {
                      pasteMany(e, video.id);
                    }}
                    onChange={(e) => {
                      updateVideo(video.id, 'source', e.target.value);
                    }}
                    placeholder="https://youtu.be/…"
                  />
                </label>
                <label>
                  <span>Título</span>
                  <input
                    required
                    value={video.title}
                    onChange={(e) => {
                      updateVideo(video.id, 'title', e.target.value);
                    }}
                  />
                </label>
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Eliminar vídeo ${String(index + 1)}`}
                  disabled={videos.length === 1}
                  onClick={() => {
                    setVideos((current) => current.filter((item) => item.id !== video.id));
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            className="text-button"
            type="button"
            disabled={videos.length >= 50}
            onClick={() => {
              setVideos((current) => [...current, initialVideo(current.length + 1)]);
            }}
          >
            <span>＋</span> Añadir otro vídeo
          </button>
        </div>
        <div className="form-footer">
          <label className="switch-row">
            <input
              type="checkbox"
              checked={analyzeVisuals}
              onChange={(e) => {
                setAnalyzeVisuals(e.target.checked);
              }}
            />
            <span className="switch" />
            <span>
              <strong>Análisis visual</strong>
              <small>Inspecciona diapositivas y pantallas compartidas</small>
            </span>
          </label>
          <button className="primary-button" disabled={busy || readyCount === 0} type="submit">
            {busy ? 'Creando…' : `Crear lote · ${String(readyCount)}`} <span>→</span>
          </button>
        </div>
      </form>
    </section>
  );
}

function BatchHistory({ batches, onOpen }: { batches: Batch[]; onOpen: (id: string) => void }) {
  return (
    <section className="batch-history" id="batches">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">ACTIVIDAD RECIENTE</p>
          <h2>Lotes en producción</h2>
        </div>
        <span className="step-label">{batches.length} EN TOTAL</span>
      </div>
      {batches.length === 0 ? (
        <div className="empty-state">
          <span>＋</span>
          <h3>Tu primer lote empieza arriba</h3>
          <p>Añade una o varias clases para seguir todo el proceso desde aquí.</p>
        </div>
      ) : (
        <div className="batch-grid">
          {batches.map((batch, index) => (
            <article className="batch-card" key={batch.id}>
              <div className="card-top">
                <StatusPill batch={batch} />
                <span className="batch-number">{String(index + 1).padStart(2, '0')}</span>
              </div>
              <h3>{batch.name}</h3>
              <p>
                {batch.counts.total} vídeo{batch.counts.total === 1 ? '' : 's'} ·{' '}
                {batch.counts.completed} completado{batch.counts.completed === 1 ? '' : 's'}
              </p>
              <div className="progress-track">
                <span style={{ width: `${String(batch.progress)}%` }} />
              </div>
              <div className="card-footer">
                <strong>{batch.progress}%</strong>
                <button
                  type="button"
                  onClick={() => {
                    onOpen(batch.id);
                  }}
                >
                  Abrir lote →
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function BatchDetail({
  batch,
  busy,
  onRetry,
  onDeliver,
  onViewAnalysis,
}: {
  batch: Batch;
  busy: boolean;
  onRetry: (jobId: string) => void;
  onDeliver: () => void;
  onViewAnalysis: (job: Job) => void;
}) {
  const canDeliver = batch.status === 'ready' && batch.delivery.status !== 'accepted';
  return (
    <section className="batch-detail" id="batch-detail">
      <div className="detail-header">
        <div>
          <p className="eyebrow">LOTE SELECCIONADO</p>
          <h2>{batch.name}</h2>
          <p>
            Creado {formatDate(batch.createdAt)} · {batch.counts.total} clases
          </p>
        </div>
        <div className="delivery-card">
          <span>ENTREGA A N8N</span>
          <strong>{deliveryLabel(batch.delivery.status)}</strong>
          <button
            className="primary-button"
            type="button"
            disabled={!canDeliver || busy}
            onClick={onDeliver}
          >
            {batch.delivery.status === 'failed' ? 'Reintentar envío' : 'Enviar lote'} <span>→</span>
          </button>
        </div>
      </div>
      <div className="batch-progress">
        <span style={{ width: `${String(batch.progress)}%` }} />
      </div>
      <div className="job-list">
        {batch.jobs.map((job, index) => (
          <article className="job-row" key={job.id}>
            <span className="job-order">{String(index + 1).padStart(2, '0')}</span>
            <div className="job-main">
              <h3>{job.submission?.title ?? job.videoId}</h3>
              <p>
                {job.videoId} · {statusLabel(job.status)}
              </p>
              {job.error && <small className="job-error">{job.error.message}</small>}
            </div>
            <div className="job-meter">
              <span>
                <i style={{ width: `${String(job.progress)}%` }} />
              </span>
              <strong>{job.progress}%</strong>
            </div>
            <div className="job-actions">
              {job.status === 'completed' && (
                <button
                  type="button"
                  onClick={() => {
                    onViewAnalysis(job);
                  }}
                >
                  Ver análisis
                </button>
              )}
              {job.status === 'failed' && (
                <button
                  type="button"
                  onClick={() => {
                    onRetry(job.id);
                  }}
                  disabled={busy}
                >
                  Reintentar
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {batch.delivery.lastError && (
        <p className="delivery-error">Último intento: {batch.delivery.lastError}</p>
      )}
    </section>
  );
}

function AnalysisPanel({ job, onClose }: { job: Job; onClose: () => void }) {
  if (!job.analysis) return null;
  const analysis = job.analysis;
  function download() {
    const blob = new Blob([JSON.stringify(analysis, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${job.videoId}-analysis.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
  return (
    <div
      className="panel-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="analysis-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="analysis-title"
      >
        <header>
          <div>
            <p className="eyebrow">ANÁLISIS COMPLETO</p>
            <h2 id="analysis-title">{job.submission?.title}</h2>
            <span>{job.videoId}</span>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar análisis">
            ×
          </button>
        </header>
        <div className="analysis-body">
          <div className="analysis-summary">
            <span>{analysis.estimated_level ?? '—'}</span>
            <p>{analysis.summary}</p>
          </div>
          <AnalysisList title="Objetivos" items={analysis.learning_objectives} />
          {!!analysis.key_concepts?.length && (
            <AnalysisCards
              title="Conceptos principales"
              items={analysis.key_concepts.map((item) => ({
                title: item.concept,
                body: item.explanation,
              }))}
            />
          )}
          {!!analysis.vocabulary?.length && (
            <AnalysisCards
              title="Vocabulario"
              items={analysis.vocabulary.map((item) => ({
                title: item.term,
                body: `${item.meaning}${item.example ? ` · ${item.example}` : ''}`,
              }))}
            />
          )}
          {!!analysis.grammar?.length && (
            <AnalysisCards
              title="Gramática"
              items={analysis.grammar.map((item) => ({
                title: item.topic,
                body: item.explanation,
              }))}
            />
          )}
          <AnalysisList title="Dificultades observadas" items={analysis.student_difficulties} />
          <AnalysisList title="Próximos pasos" items={analysis.next_steps} />
          {analysis.transcript && (
            <details className="transcript">
              <summary>Transcripción completa</summary>
              <pre>{analysis.transcript}</pre>
            </details>
          )}
        </div>
        <footer>
          <button className="secondary-button" type="button" onClick={download}>
            Descargar JSON
          </button>
          <button className="primary-button" type="button" onClick={onClose}>
            Cerrar
          </button>
        </footer>
      </aside>
    </div>
  );
}

function AnalysisList({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <section className="analysis-section">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
function AnalysisCards({
  title,
  items,
}: {
  title: string;
  items: Array<{ title: string; body: string }>;
}) {
  return (
    <section className="analysis-section">
      <h3>{title}</h3>
      <div className="analysis-cards">
        {items.map((item) => (
          <article key={item.title}>
            <strong>{item.title}</strong>
            <p>{item.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
function StatusPill({ batch }: { batch: Batch }) {
  const label =
    batch.status === 'processing'
      ? 'Procesando'
      : batch.status === 'attention'
        ? 'Requiere atención'
        : batch.delivery.status === 'accepted'
          ? 'Enviado'
          : 'Listo';
  return (
    <span
      className={`status ${batch.status === 'ready' ? 'ready' : batch.status === 'attention' ? 'failed' : ''}`}
    >
      {label}
    </span>
  );
}

function LoginScreen({
  onLogin,
  busy,
  notice,
}: {
  onLogin: (password: string) => void;
  busy: boolean;
  notice: { kind: 'success' | 'error'; text: string } | null;
}) {
  const [password, setPassword] = useState('');
  return (
    <main className="login-page">
      <section className="login-story">
        <a className="brand" href="/">
          <span className="brand-mark">E</span>
          <span>
            <strong>ETM</strong>
            <small>CLASS ENGINE</small>
          </span>
        </a>
        <div>
          <p className="eyebrow">ESPACIO PRIVADO</p>
          <h1>
            De la clase grabada a una lectura que <em>sí enseña.</em>
          </h1>
          <p>
            Procesa varias sesiones como una sola unidad y entrégala a tu flujo editorial en n8n.
          </p>
        </div>
        <small>TRANSCRIPCIÓN · ANÁLISIS · NOTION</small>
      </section>
      <section className="login-form-wrap">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onLogin(password);
          }}
        >
          <p className="eyebrow">ACCESO DE OPERADOR</p>
          <h2>Bienvenido de nuevo</h2>
          <p>Introduce la contraseña privada configurada para este servidor.</p>
          <label>
            <span>Contraseña</span>
            <input
              autoFocus
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          </label>
          {notice?.kind === 'error' && <p className="login-error">{notice.text}</p>}
          <button className="primary-button" disabled={busy || !password} type="submit">
            {busy ? 'Comprobando…' : 'Entrar al panel'} <span>→</span>
          </button>
        </form>
      </section>
    </main>
  );
}

function LoadingScreen() {
  return (
    <div className="loading-screen">
      <span className="brand-mark">E</span>
      <p>Preparando el panel…</p>
    </div>
  );
}
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.method && options.method !== 'GET' ? { 'x-etm-ui': '1' } : {}),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(response.status, payload.message ?? `Error HTTP ${String(response.status)}`);
  }
  return response.json() as Promise<T>;
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Ocurrió un error inesperado';
}
function formatDate(value: string): string {
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}
function statusLabel(status: string): string {
  return (
    (
      {
        queued: 'En cola',
        validating_video: 'Validando vídeo',
        downloading: 'Descargando',
        extracting_audio: 'Preparando audio',
        transcribing: 'Transcribiendo',
        extracting_frames: 'Extrayendo imágenes',
        analyzing_visuals: 'Analizando imágenes',
        synthesizing: 'Generando análisis',
        sending_callback: 'Guardando resultado',
        completed: 'Completado',
        failed: 'Fallido',
      } as Record<string, string>
    )[status] ?? status
  );
}
function deliveryLabel(status: Delivery['status']): string {
  return {
    not_sent: 'Pendiente',
    sending: 'Enviando…',
    accepted: 'Aceptado por n8n',
    failed: 'Falló el envío',
  }[status];
}

const root = document.getElementById('root');
if (!root) throw new Error('No se encontró el contenedor principal de la interfaz');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
