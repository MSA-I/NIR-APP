import { writeFile } from 'node:fs/promises';
import type { RunReport } from './schemas.ts';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

export async function writeHtmlReport(filePath: string, report: RunReport): Promise<void> {
  const roles = [...new Set([
    ...report.roles.map((role) => role.role),
    ...report.findings.flatMap((finding) => [finding.role, ...finding.affectedRoles]),
  ])];
  const options = (values: readonly string[]) => values.map((value) =>
    `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`,
  ).join('');
  const findings = JSON.stringify(report.findings).replace(/</g, '\\u003c');
  const scenarios = report.scenarios.map((scenario) =>
    `<li><strong>${escapeHtml(scenario.name)}</strong><span>${scenario.status} · ${scenario.durationMs}ms</span></li>`,
  ).join('');
  const roleSummaries = report.roles.map((role) =>
    `<article class="role"><h3>${escapeHtml(role.role)}</h3><p>${escapeHtml(role.purpose)}</p><strong>${role.status}</strong></article>`,
  ).join('');
  const document = `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SupplyFlow QA — ${escapeHtml(report.runId)}</title>
<style>
:root{font-family:"IBM Plex Sans Hebrew",Heebo,ui-sans-serif,system-ui,sans-serif;color:oklch(22% .025 205);background:oklch(96.8% .01 85)}body{margin:0;padding:24px;line-height:1.55}main{max-width:1200px;margin:auto}.panel{background:oklch(99.2% .004 85);border:1px solid oklch(88.5% .014 80);border-radius:12px;padding:18px;margin-block:14px}h1,h2{margin-block:0 12px}.summary,.roles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.metric,.role{background:oklch(93.41% .0182 205.32);color:oklch(38.19% .0588 211.94);padding:12px;border-radius:8px}.filters{display:flex;gap:10px;flex-wrap:wrap}label{display:grid;gap:4px}select{min-height:44px;padding:8px}.finding{border-block-start:1px solid oklch(93.2% .011 82);padding-block:14px}.critical,.high,.medium,.low{background:oklch(95.2% .012 85);border-radius:8px;padding-inline:12px}.meta{color:oklch(44% .022 205);font-size:.9rem}ul{padding-inline-start:22px}li{display:flex;justify-content:space-between;gap:18px;margin-block:8px}pre{direction:ltr;text-align:start;white-space:pre-wrap;overflow-wrap:anywhere}.evidence{display:flex;gap:8px;flex-wrap:wrap}.evidence img{display:block;max-width:min(100%,480px);height:auto;border:1px solid oklch(88.5% .014 80);border-radius:8px}@media(max-width:600px){body{padding:10px}li{display:block}}
</style></head><body><main>
<header class="panel"><h1>דוח QA — SupplyFlow</h1><p>${escapeHtml(report.runId)} · ${report.overallStatus} · ${escapeHtml(report.environment.gitSha)}</p></header>
<section class="panel summary"><div class="metric">עברו<br><strong>${report.statistics.passedScenarios}</strong></div><div class="metric">נכשלו<br><strong>${report.statistics.failedScenarios}</strong></div><div class="metric">חסומים<br><strong>${report.statistics.blockedScenarios}</strong></div><div class="metric">ממצאים<br><strong>${report.findings.length}</strong></div></section>
<section class="panel"><h2>סיכום תפקידים</h2><div class="roles">${roleSummaries}</div></section>
<section class="panel"><h2>סינון ממצאים</h2><div class="filters"><label>תפקיד<select id="role"><option value="">הכול</option>${options(roles)}</select></label><label>חומרה<select id="severity"><option value="">הכול</option>${options(['critical','high','medium','low','info'])}</select></label><label>קטגוריה<select id="category"><option value="">הכול</option>${options(Object.keys(report.statistics.byCategory))}</select></label></div><div id="findings"></div></section>
<section class="panel"><h2>ציר תרחישים</h2><ul>${scenarios}</ul></section>
<section class="panel"><h2>כיסוי חסום</h2><ul>${report.blockedItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>
<section class="panel"><h2>בדיקות אנושיות שעדיין נדרשות</h2><ul>${report.humanTestingRequired.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>
</main><script>
const findings=${findings};const root=document.getElementById('findings');const filters=['role','severity','category'];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const href=s=>/^(?![a-z]+:|\\/\\/)(?!.*\\.\\.)[^<>]+$/i.test(String(s))?encodeURI(String(s).replace(/\\\\/g,'/')):'';
function evidence(f){const images=(f.evidence.screenshots||[]).map(p=>href(p)?'<a href="'+esc(href(p))+'"><img loading="lazy" src="'+esc(href(p))+'" alt="צילום מסך לראיה: '+esc(f.title)+'"></a>':'').join('');const paths=Object.values(f.evidence).flatMap(v=>Array.isArray(v)?v:typeof v==='string'?[v]:[]).filter(p=>href(p)).map(p=>'<a href="'+esc(href(p))+'">'+esc(p)+'</a>').join(' ');return '<div class="evidence">'+images+paths+'</div>'}
function render(){const q=Object.fromEntries(filters.map(id=>[id,document.getElementById(id).value]));const rows=findings.filter(f=>(!q.role||f.role===q.role||f.affectedRoles.includes(q.role))&&(!q.severity||f.severity===q.severity)&&(!q.category||f.category===q.category));root.innerHTML=rows.map(f=>'<article class="finding '+esc(f.severity)+'"><h3>'+esc(f.title)+'</h3><p class="meta">'+esc(f.role)+' · '+esc(f.category)+' · '+esc(f.severity)+' · '+esc(f.status)+'</p><p>'+esc(f.userImpact)+'</p><details><summary>פרטים וראיות</summary><p><strong>צפוי:</strong> '+esc(f.expected||'—')+'</p><p><strong>בפועל:</strong> '+esc(f.actual||'—')+'</p><ol>'+f.reproductionSteps.map(s=>'<li>'+esc(s)+'</li>').join('')+'</ol>'+evidence(f)+'<pre>'+esc(JSON.stringify(f.evidence,null,2))+'</pre></details></article>').join('')||'<p>אין ממצאים במסנן זה.</p>'}filters.forEach(id=>document.getElementById(id).addEventListener('change',render));render();
</script></body></html>`;
  await writeFile(filePath, document, 'utf8');
}
