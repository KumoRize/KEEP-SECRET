import { useCallback, useEffect, useState } from 'react';
import { api, MODALITY_LABELS, type Generation } from '../api';
import { AssetPreview } from '../components/AssetPreview';

interface Project { id: string; name: string; generation_count: number }

export function LibraryPage() {
  const [items, setItems] = useState<Generation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [modality, setModality] = useState('');
  const [projectId, setProjectId] = useState('');
  const [newProject, setNewProject] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ ...(modality && { modality }), ...(projectId && { projectId }) });
    const [g, p] = await Promise.all([
      api<{ items: Generation[] }>(`/generations?${qs}`),
      api<{ items: Project[] }>('/library/projects'),
    ]);
    setItems(g.items);
    setProjects(p.items);
  }, [modality, projectId]);

  useEffect(() => { void load(); }, [load]);

  const createProject = async () => {
    if (!newProject.trim()) return;
    await api('/library/projects', { method: 'POST', json: { name: newProject } });
    setNewProject('');
    void load();
  };

  const move = async (genId: string, pid: string) => {
    await api(`/library/generations/${genId}/move`, { method: 'POST', json: { projectId: pid || null } });
    void load();
  };

  return (
    <div className="stack">
      <section className="card stack">
        <h1>Library</h1>
        <div className="row wrap">
          <select value={modality} onChange={(e) => setModality(e.target.value)} aria-label="Filter by type">
            <option value="">All types</option>
            {Object.entries(MODALITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Filter by project">
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.generation_count})</option>)}
          </select>
        </div>
        <div className="row">
          <input className="grow" placeholder="New project name" value={newProject} onChange={(e) => setNewProject(e.target.value)} />
          <button onClick={createProject}>Add</button>
        </div>
      </section>
      {items.length === 0 && <p className="muted center">Nothing here yet.</p>}
      <ul className="grid">
        {items.map((g) => (
          <li key={g.id} className="card stack">
            <div className="row between">
              <strong>{MODALITY_LABELS[g.modality]}</strong>
              <span className={`status ${g.status}`}>{g.status}</span>
            </div>
            <p className="clamp">{g.prompt}</p>
            <div className="row between muted small">
              <span>{new Date(g.createdAt).toLocaleString('en-IN')}</span>
              <span>{g.chargedCredits ?? g.heldCredits} cr</span>
            </div>
            {g.assets.length > 0 && (
              open === g.id
                ? g.assets.map((a) => <AssetPreview key={a.id} asset={a} />)
                : <button onClick={() => setOpen(g.id)}>Preview</button>
            )}
            <select value={g.projectId ?? ''} onChange={(e) => move(g.id, e.target.value)} aria-label="Move to project">
              <option value="">No project</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </li>
        ))}
      </ul>
    </div>
  );
}
