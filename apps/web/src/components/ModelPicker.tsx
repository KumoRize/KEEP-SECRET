import { useModels } from '../lib/catalog';

/** Native select (accessible, mobile-friendly) listing models for one category; free models flagged. */
export function ModelPicker({ category, value, onChange, autoLabel = 'Auto: best model' }: {
  category: string; value: string; onChange: (id: string) => void; autoLabel?: string;
}) {
  const { items } = useModels();
  const models = items.filter((m) => m.categories.includes(category));
  const free = models.filter((m) => m.isFree);
  const paid = models.filter((m) => !m.isFree);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Model">
      <option value="">{autoLabel}</option>
      {paid.length > 0 && (
        <optgroup label="Premium">
          {paid.map((m) => <option key={m.id} value={m.id}>{m.label} · {m.priceHint}</option>)}
        </optgroup>
      )}
      {free.length > 0 && (
        <optgroup label="Free">
          {free.map((m) => <option key={m.id} value={m.id}>{m.label} · Free</option>)}
        </optgroup>
      )}
    </select>
  );
}
