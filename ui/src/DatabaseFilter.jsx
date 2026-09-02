import { useEffect, useRef, useState } from 'react';
import { OPERATORS, compileRules, parseQuery } from '../js/dbFilter.js';
import { Tooltip } from './Tooltip.jsx';

let nextRuleId = 1;
const newRule = (fields) => ({
  id: nextRuleId++, field: fields[0]?.key ?? '', op: 'eq', value: '',
});

/**
 * Popover next to the Database search box: a rule builder (field / operator /
 * value rows joined by AND or OR) or a SQL-ish query string. Apply compiles
 * either into a predicate the grid filters with.
 *
 * `draft` / `onDraft` keep the form's state in the parent so it survives
 * closing the panel and switching tables.
 */
export function DatabaseFilter({ fields, draft, onDraft, onApply, onClear, onClose, active }) {
  const [error, setError] = useState(null);
  const queryRef = useRef(null);
  const tab = draft.tab || 'advanced';
  const rules = draft.rules?.length ? draft.rules : [newRule(fields)];
  const match = draft.match || 'and';
  const queryText = draft.query || '';

  const set = (patch) => onDraft({ ...draft, rules, match, query: queryText, tab, ...patch });

  useEffect(() => {
    if (tab === 'query') queryRef.current?.focus();
  }, [tab]);

  const apply = () => {
    setError(null);
    try {
      const compiled = tab === 'query'
        ? parseQuery(queryText, fields)
        : compileRules(rules, match, fields);
      onApply({ ...compiled, mode: tab });
    } catch (e) {
      setError({ message: e.message, pos: e.pos });
    }
  };

  const onKey = (e) => {
    const key = e.key || e.code;
    if (key === 'Escape') { e.preventDefault(); onClose?.(); return; }
    // Enter applies from the value boxes and the query textarea (Shift+Enter
    // still inserts a newline there).
    const enter = key === 'Enter' || key === 'NumpadEnter' || e.keyCode === 13;
    if (!enter || e.shiftKey) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') { e.preventDefault(); apply(); }
  };

  const updateRule = (id, patch) => set({ rules: rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const removeRule = (id) => {
    const next = rules.filter((r) => r.id !== id);
    set({ rules: next.length ? next : [newRule(fields)] });
  };

  return (
    <div className="dbf-panel" role="dialog" aria-label="Filters" onKeyDown={onKey}>
      <div className="dbf-head">
        <div className="seg-tabs" role="tablist" aria-label="Filter mode">
          {[['advanced', 'Advanced Filters'], ['query', 'Query String']].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`seg-tab${tab === id ? ' on' : ''}`}
              onClick={() => { setError(null); set({ tab: id }); }}
            >
              {label}
            </button>
          ))}
        </div>
        <Tooltip content="Close" placement="left">
          <button type="button" className="icon-btn dbf-close" aria-label="Close" onClick={onClose}>
            <span className="icon">close</span>
          </button>
        </Tooltip>
      </div>

      {tab === 'advanced' ? (
        <div className="dbf-body">
          <div className="dbf-match">
            <span className="dbf-label">Match</span>
            <div className="seg-tabs dbf-match-tabs" role="radiogroup" aria-label="Combine rules with">
              {[['and', 'All (AND)'], ['or', 'Any (OR)']].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={match === id}
                  className={`seg-tab${match === id ? ' on' : ''}`}
                  onClick={() => set({ match: id })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="dbf-rules">
            {rules.map((r) => {
              const op = OPERATORS.find((o) => o.key === r.op) || OPERATORS[0];
              return (
                <div key={r.id} className="dbf-rule">
                  <select
                    className="dbf-select dbf-field"
                    value={r.field}
                    onChange={(e) => updateRule(r.id, { field: e.target.value })}
                    aria-label="Field"
                  >
                    {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                  <select
                    className="dbf-select dbf-op"
                    value={r.op}
                    onChange={(e) => updateRule(r.id, { op: e.target.value })}
                    aria-label="Operator"
                  >
                    {OPERATORS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </select>
                  <input
                    type="text"
                    className="list-search dbf-value"
                    value={r.value}
                    disabled={!!op.unary}
                    placeholder={op.unary ? '' : 'value'}
                    onChange={(e) => updateRule(r.id, { value: e.target.value })}
                    aria-label="Value"
                    spellCheck={false}
                  />
                  <Tooltip content="Remove rule" placement="left">
                    <button type="button" className="icon-btn dbf-remove" aria-label="Remove rule" onClick={() => removeRule(r.id)}>
                      <span className="icon">close</span>
                    </button>
                  </Tooltip>
                </div>
              );
            })}
          </div>
          <button type="button" className="dbf-add" onClick={() => set({ rules: [...rules, newRule(fields)] })}>
            <span className="icon">add</span>
            Add filter
          </button>
        </div>
      ) : (
        <div className="dbf-body">
          <textarea
            ref={queryRef}
            className="dbf-query mono"
            rows={3}
            value={queryText}
            placeholder={'str > 20 and int > 20\nname contains "haubert" or jobs has WAR'}
            onChange={(e) => set({ query: e.target.value })}
            spellCheck={false}
          />
          <div className="dbf-hint">
            Fields: {fields.slice(0, 14).map((f) => f.label).join(', ')}{fields.length > 14 ? ', …' : ''}.
            Operators: = != &lt; &lt;= &gt; &gt;= contains has startswith endswith, is empty, and / or / not, ( ).
            Quote values with spaces.
          </div>
        </div>
      )}

      {error && (
        <div className="dbf-error mono" role="alert">
          <span className="icon">error</span>
          {error.message}{error.pos != null ? ` (at ${error.pos + 1})` : ''}
        </div>
      )}

      <div className="dbf-foot">
        {active?.summary
          ? <span className="dbf-active mono" title={active.summary}>{active.summary}</span>
          : <span className="dbf-active muted">No filter applied</span>}
        <button type="button" className="dbf-btn" onClick={() => { setError(null); onClear(); }} disabled={!active?.predicate}>
          Clear
        </button>
        <button type="button" className="dbf-btn primary" onClick={apply}>
          <span className="icon">search</span>
          Search
        </button>
      </div>
    </div>
  );
}
