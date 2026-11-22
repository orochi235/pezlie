import { useMemo } from 'react';
import { ControlPanel, f, resolveConfigSchema, type ConfigEntry } from '@weasel-js/labkit';
import type { ParamField, ParamSchema, Params } from './params';
import './ParamsPanel.css';

export interface ParamsPanelProps {
  schema: Pick<ParamSchema, 'groups' | 'units'>;
  params: Params;
  setParam: <K extends keyof Params>(key: K, value: Params[K]) => void;
  reset: () => void;
}

function paramNode(field: ParamField, unit: string | undefined): ConfigEntry {
  switch (field.type) {
    case 'slider':
    case 'number': {
      const node = f.number(field.default).range(field.min, field.max).step(field.step)
        .label(field.label);
      const control = field.type === 'slider' ? node.slider() : node.input();
      return unit === undefined ? control : control.suffix(unit);
    }
    case 'checkbox': return f.boolean(field.default).label(field.label);
    case 'color': return f.color(field.default).label(field.label);
    case 'select': return f.enum(field.default, field.options).label(field.label);
  }
}

/** The wall's tuning constants, inline in the sidebar beside the filters. */
export function ParamsPanel({ schema, params, setParam, reset }: ParamsPanelProps) {
  const schemas = useMemo(() => schema.groups.map((group) => {
    const nodes = Object.fromEntries(group.fields.map((field) =>
      [field.key, paramNode(field, schema.units[field.key])]));
    return { label: group.label, resolved: resolveConfigSchema(f.schema(nodes)) };
  }), [schema]);

  return (
    <div className="wall-params-panel">
      <h3>
        Params
        <button type="button" onClick={reset}>reset</button>
      </h3>
      <div className="wall-params-body">
        {schemas.map(({ label, resolved }) => (
          <section key={label} className="wall-params-group">
            <h4>{label}</h4>
            <ControlPanel
              schema={resolved}
              config={params as unknown as Record<string, unknown>}
              setConfig={(key, value) => setParam(key as keyof Params, value as never)}
            />
          </section>
        ))}
      </div>
    </div>
  );
}
