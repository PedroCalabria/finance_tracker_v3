import { useState } from 'react';
import { formatMonthShort, type InvestmentOverview, type SeriesPoint } from '@ff/shared';
import { Segmented, brl } from '../components/ui';

type Range = '6m' | '1y' | 'proj';
interface Point extends SeriesPoint {
  projected: boolean;
}

/**
 * "Evolução" (ADR-0012): duas séries, o aportado (linha) e o saldo bruto (área), com a marca de hoje e a
 * projeção tracejada. SVG próprio, sem biblioteca e sem paleta de séries; textos e eixos em HTML.
 */
export function InvestmentChart({ overview }: { overview: InvestmentOverview }) {
  const [range, setRange] = useState<Range>('1y');
  const past = overview.past;
  const points: Point[] =
    range === 'proj'
      ? [...past.slice(-1).map((p) => ({ ...p, projected: false })), ...overview.projection.map((p) => ({ ...p, projected: true }))]
      : past.slice(range === '6m' ? -6 : -12).map((p) => ({ ...p, projected: false }));
  if (points.length < 2) return null;

  const top = Math.max(1, ...points.map((p) => Math.max(p.grossCents, p.principalCents))) * 1.1;
  const x = (i: number) => (i / (points.length - 1)) * 100;
  const y = (v: number) => 100 - (Math.max(0, v) / top) * 100;
  const line = (ps: Array<{ i: number; v: number }>) => ps.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(3)},${y(p.v).toFixed(2)}`).join(' ');
  const todayIdx = points.findIndex((p) => p.projected) - 1;
  const today = todayIdx >= 0 ? todayIdx : points.length - 1;
  const solid = points.map((p, i) => ({ p, i })).filter(({ i }) => i <= today);
  const dashed = points.map((p, i) => ({ p, i })).filter(({ i }) => i >= today);
  const area = `M0,100 ${points.map((p, i) => `L${x(i).toFixed(3)},${y(p.grossCents).toFixed(2)}`).join(' ')} L100,100 Z`;

  const first = points[0]!;
  const last = points.at(-1)!;
  const summary =
    range === 'proj'
      ? `Em 2 anos, guardando o planejado: cerca de ${brl(last.grossCents)}, com ${brl(last.principalCents)} aportados.`
      : `Em ${range === '6m' ? '6 meses' : '1 ano'}: aportou ${brl(last.principalCents - first.principalCents)} e rendeu ${brl(
          last.grossCents - last.principalCents - (first.grossCents - first.principalCents),
        )}. Hoje: ${brl(last.grossCents)}.`;
  const step = points.length > 13 ? 6 : points.length > 7 ? 3 : 1;
  const ticks = points.map((p, i) => ({ i, p })).filter(({ i }) => i % step === 0 || i === points.length - 1);

  return (
    <div className="app-invchart">
      <div className="app-toolbar">
        <ul className="app-invchart__legend" aria-hidden="true">
          <li>
            <span className="app-invchart__swatch app-invchart__swatch--gross" />
            Saldo
          </li>
          <li>
            <span className="app-invchart__swatch app-invchart__swatch--principal" />
            Aportado
          </li>
        </ul>
        <Segmented
          label="Período do gráfico"
          value={range}
          onChange={setRange}
          options={[
            { value: '6m', label: '6 meses' },
            { value: '1y', label: '1 ano' },
            { value: 'proj', label: 'Projeção 2 anos' },
          ]}
        />
      </div>
      <div className="app-invchart__plot">
        <span className="app-invchart__max ff-num" aria-hidden="true">
          {brl(Math.round(top))}
        </span>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`Evolução das caixinhas. ${summary}`}>
          <path className="app-invchart__area" d={area} />
          <path className="app-invchart__gross" d={line(solid.map(({ p, i }) => ({ i, v: p.grossCents })))} vectorEffect="non-scaling-stroke" />
          {dashed.length > 1 && <path className="app-invchart__gross is-projected" d={line(dashed.map(({ p, i }) => ({ i, v: p.grossCents })))} vectorEffect="non-scaling-stroke" />}
          <path className="app-invchart__principal" d={line(solid.map(({ p, i }) => ({ i, v: p.principalCents })))} vectorEffect="non-scaling-stroke" />
          {dashed.length > 1 && (
            <path className="app-invchart__principal is-projected" d={line(dashed.map(({ p, i }) => ({ i, v: p.principalCents })))} vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        <span className={`app-invchart__today${x(today) > 90 ? ' is-end' : ''}`} style={{ left: `${x(today)}%` }} aria-hidden="true">
          <span>hoje</span>
        </span>
      </div>
      <div className="app-invchart__axis" aria-hidden="true">
        {ticks.map(({ i, p }) => (
          <span key={p.month} className={i === 0 ? 'is-start' : i === points.length - 1 ? 'is-end' : undefined} style={{ left: `${x(i)}%` }}>
            {formatMonthShort(p.month, i === 0 || p.month.endsWith('-01'))}
          </span>
        ))}
      </div>
      <p className="ff-caption app-m0">{summary}</p>
    </div>
  );
}
