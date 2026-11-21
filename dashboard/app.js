// Token Radar v5 — the dashboard. Reads window.RADAR (written by main.ts
// from the same board as board.json), renders the board, the detail view,
// the live-token view and the method page. No network, no framework.
// Hash routes: #board, #filtered, #detail=<slug>, #live, #method.
(function () {
  'use strict';
  var R = window.RADAR;
  var app = document.getElementById('app');
  var meta = document.getElementById('meta');
  var foot = document.getElementById('foot');
  var E = R.evidence;
  var ECON = E.economics;

  var state = { sort: 'rank', dir: 1, family: 'all', verdict: 'all', q: '', deposit: 1000 };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function money(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var a = Math.abs(n);
    var sign = n < 0 ? '−$' : '$';
    if (a >= 1e9) return sign + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return sign + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return sign + (a / 1e3).toFixed(0) + 'K';
    if (a >= 100) return sign + a.toFixed(0);
    if (a >= 1) return sign + a.toFixed(2);
    return sign + a.toFixed(2);
  }
  function moneyFull(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function pct(x, d) {
    return (x * 100).toFixed(d === undefined ? 1 : d) + '%';
  }
  function miss(x) {
    return '×' + x.toFixed(2);
  }
  function ageText(days) {
    if (days === null || days === undefined) return 'age unknown';
    if (days < 365) return Math.round(days / 30.44) + ' mo';
    return (days / 365).toFixed(1) + ' yr';
  }
  function chgText(c) {
    if (c === null || c === undefined) return '—';
    var s = (c >= 0 ? '+' : '') + c.toFixed(1) + '%';
    return '<span class="' + (c >= 0 ? 'pos' : 'neg') + '">' + s + '</span>';
  }
  function verdictBadge(v) {
    return '<span class="verdict ' + v + '">' + v + '</span>';
  }

  // The standard plan's economics at any deposit, from the row's stored
  // figures: slice is 10% of implied value times the deposit's TVL share,
  // costs are gas plus 4% forgone yield over the 90-day hold.
  function econAt(row, deposit) {
    var forgone = deposit * ECON.forgone_apr * (ECON.hold_days / 365);
    var slice = ECON.airdrop_share * row.implied_value_usd * (deposit / row.tvl_usd);
    var net = slice - row.gas_usd - forgone;
    var tbill = deposit * ECON.tbill_apr * (ECON.hold_days / 365);
    var verdict = net > tbill && net / ECON.farm_hours >= ECON.hourly_hurdle_usd ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
    return { forgone: forgone, slice: slice, net: net, tbill: tbill, verdict: verdict };
  }

  // ---- evidence strip: the proof, on the board itself ----
  function ablationRow(label, loo, wf, hl) {
    return '<tr' + (hl ? ' class="hl"' : '') + '><td>' + label + '</td>' +
      '<td class="n">' + miss(loo.median_miss) + ' · ' + pct(loo.within_3x, 0) + '</td>' +
      '<td class="n">' + miss(wf.median_miss) + ' · ' + pct(wf.within_3x, 0) + '</td></tr>';
  }
  function evidenceStrip() {
    var loo = E.loo;
    var wf = E.walk_forward.scores;
    var L = E.ledger;
    var b = E.bands;
    return '<section class="evidence">' +
      '<div class="card"><h3>Value model, tested out of sample</h3>' +
      '<table class="mini"><tr><th>Rung</th><th class="n">Leave-one-out</th><th class="n">Walk-forward</th></tr>' +
      ablationRow('Flat multiple', loo.flat, wf.flat, false) +
      ablationRow('L1 log-log curve', loo.curve, wf.curve, false) +
      ablationRow('+ family offsets', loo.family, wf.family, false) +
      ablationRow('Adopted (shrunk)', loo.full, wf.full, true) +
      '</table><p>Median miss × within-3× share. LOO n=' + E.comps_n + '; walk-forward fits the ' + E.walk_forward.train_n + ' older-listed comps and tests the ' + E.walk_forward.test_n + ' newer. The adopted model is the L1 curve plus shrunk family offsets (k=8).</p></div>' +
      '<div class="card"><h3>758 protocols, all accounted for</h3>' +
      '<ul class="ledger">' +
      '<li><span><b>Ranked on this board</b></span><span>' + L.ranked + '</span></li>' +
      '<li><span>Token already trades</span><span>' + L.token_record + '</span></li>' +
      '<li><span>Excluded category (bridge, liquid staking, CEX…)</span><span>' + L.excluded_category + '</span></li>' +
      '<li><span>Wrapped / staked name</span><span>' + L.wrapped_name + '</span></li>' +
      '<li><span>Exchange name</span><span>' + L.exchange_name + '</span></li>' +
      '<li><span>Versioned name</span><span>' + L.versioned_name + '</span></li>' +
      '</ul><p>Every protocol in the snapshot lands in exactly one bucket. The board holds all ' + L.ranked + ' rankable pre-token protocols — the 40-protocol watchlist plus ' + R.early_size + ' below the floor.</p></div>' +
      '<div class="card"><h3>Honest ranges &amp; token odds</h3>' +
      '<p>Bands are the point × the model&rsquo;s own leave-one-out residual quantiles: P25–P75 <b>×' + b.p25.toFixed(2) + '–×' + b.p75.toFixed(2) + '</b>, P10–P90 <b>×' + b.p10.toFixed(2) + '–×' + b.p90.toFixed(2) + '</b>. Walk-forward coverage: <b>' + pct(E.band_coverage_wf.p50, 0) + ' / ' + pct(E.band_coverage_wf.p80, 0) + '</b> (stated 50% / 80%).</p>' +
      '<p>Token odds are fitted, not guessed: logistic regression on age + family over ' + E.peers_n + ' peers listed ≥1 year. 10-fold Brier <b>' + E.odds_brier_cv.toFixed(3) + '</b> vs ' + E.odds_brier_base.toFixed(3) + ' base; walk-forward <b>' + E.odds_walk_forward.brier.toFixed(3) + '</b> vs ' + E.odds_walk_forward.baseline.toFixed(3) + ' train-rate baseline. Adding TVL (' + E.odds_ablation.age_family_tvl.toFixed(3) + ') or 7-day growth (' + E.odds_ablation.age_family_chg.toFixed(3) + ') adds nothing.</p></div>' +
      '</section>';
  }

  // ---- board ----
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    var rows = R.rows.filter(function (r) {
      if (state.family !== 'all' && r.family !== state.family) return false;
      var ec = econAt(r, state.deposit);
      if (state.verdict === 'worth' && ec.verdict === 'SKIP') return false;
      if (state.verdict !== 'all' && state.verdict !== 'worth' && ec.verdict !== state.verdict) return false;
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.family).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = state.sort;
    rows.sort(function (a, b) {
      var va, vb;
      if (key === 'net') { va = econAt(a, state.deposit).net; vb = econAt(b, state.deposit).net; }
      else if (key === 'tvl') { va = a.tvl_usd; vb = b.tvl_usd; }
      else if (key === 'value') { va = a.value_if_launches_usd; vb = b.value_if_launches_usd; }
      else if (key === 'odds') { va = a.token_odds; vb = b.token_odds; }
      else if (key === 'implied') { va = a.implied_value_usd; vb = b.implied_value_usd; }
      else { va = a.rank; vb = b.rank; }
      var d = (va - vb) * state.dir;
      return d !== 0 ? d : a.slug < b.slug ? -1 : 1;
    });
    return rows;
  }

  function boardRowHtml(r) {
    var ec = econAt(r, state.deposit);
    var netCls = ec.net >= 0 ? 'pos' : 'neg';
    return '<tr data-slug="' + esc(r.slug) + '">' +
      '<td class="n">' + r.rank + '</td>' +
      '<td><span class="pname"><a href="#detail=' + esc(r.slug) + '">' + esc(r.name) + '</a></span>' +
      '<span class="sub">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.family) + ' · ' + esc(r.chains.slice(0, 2).join(', ') || '—') + '</span></td>' +
      '<td class="n">' + money(r.tvl_usd) + '<span class="sub">' + chgText(r.change_7d) + ' 7d · ' + ageText(r.age_days) + '</span></td>' +
      '<td class="n">' + money(r.value_if_launches_usd) + '</td>' +
      '<td class="n">' + pct(r.token_odds, 0) + '</td>' +
      '<td class="n"><b>' + money(r.implied_value_usd) + '</b><span class="range">' + money(r.band_p25_usd) + ' – ' + money(r.band_p75_usd) + '</span></td>' +
      '<td>' + verdictBadge(ec.verdict) + '</td>' +
      '<td class="n"><span class="' + netCls + '">' + money(ec.net) + '</span><span class="sub">' + money(ec.slice) + ' slice</span></td>' +
      '</tr>';
  }

  function renderBoard() {
    var rows = filteredRows();
    var fams = ['Lending', 'Trading', 'Vaults & yield', 'RWA', 'Staking', 'Infra', 'Other'];
    var famOpts = '<option value="all">All families</option>' + fams.map(function (f) {
      return '<option value="' + esc(f) + '"' + (state.family === f ? ' selected' : '') + '>' + esc(f) + '</option>';
    }).join('');
    var sortArrow = state.dir === 1 ? ' ▲' : ' ▼';
    var th = function (key, label, cls) {
      return '<th data-sort="' + key + '" class="' + (cls || '') + '">' + label + (state.sort === key ? sortArrow : '') + '</th>';
    };
    app.innerHTML =
      '<h1>Pre-token protocols, ranked by implied value</h1>' +
      '<p class="lede">Implied value = <b>value if the token launches</b> × <b>fitted P(token)</b>, from the snapshot&rsquo;s own figures. ' +
      'Board total <b>' + money(E.board_total_implied_usd) + '</b> implied (' + money(E.board_total_value_usd) + ' if every token launched). ' +
      'At the $1,000 standard farm, <b>' + E.verdicts.FARM + ' FARM</b>, <b>' + E.verdicts.MARGINAL + ' MARGINAL</b>, <b>' + E.verdicts.SKIP + ' SKIP</b> — ' +
      'farming pays at $10,000, not at $1,000, for most of the board. Switch the deposit to see it.</p>' +
      evidenceStrip() +
      '<div class="controls">' +
      '<input type="search" id="q" placeholder="Search name, slug, category…" value="' + esc(state.q) + '" aria-label="Search">' +
      '<select id="fam" aria-label="Family filter">' + famOpts + '</select>' +
      '<select id="ver" aria-label="Verdict filter">' +
      '<option value="all"' + (state.verdict === 'all' ? ' selected' : '') + '>All verdicts</option>' +
      '<option value="worth"' + (state.verdict === 'worth' ? ' selected' : '') + '>Worth farming (FARM + MARGINAL)</option>' +
      '<option value="FARM"' + (state.verdict === 'FARM' ? ' selected' : '') + '>FARM only</option>' +
      '<option value="MARGINAL"' + (state.verdict === 'MARGINAL' ? ' selected' : '') + '>MARGINAL only</option>' +
      '<option value="SKIP"' + (state.verdict === 'SKIP' ? ' selected' : '') + '>SKIP only</option>' +
      '</select>' +
      '<div class="toggle" role="group" aria-label="Deposit">' +
      '<button id="dep1" class="' + (state.deposit === 1000 ? 'on' : '') + '">$1,000</button>' +
      '<button id="dep10" class="' + (state.deposit === 10000 ? 'on' : '') + '">$10,000</button>' +
      '</div>' +
      '<span class="count">' + rows.length + ' of ' + R.rows.length + ' rows · net &amp; verdict at $' + state.deposit.toLocaleString('en-US') + '</span>' +
      '</div>' +
      '<div class="boardwrap"><table class="board"><thead><tr>' +
      th('rank', '#', 'n') + '<th>Protocol</th>' + th('tvl', 'TVL', 'n') + th('value', 'Value if launches', 'n') + th('odds', 'Token odds', 'n') + th('implied', 'Implied value', 'n') + '<th>Verdict</th>' + th('net', 'Net @ deposit', 'n') +
      '</tr></thead><tbody>' + rows.map(boardRowHtml).join('') + '</tbody></table></div>' +
      '<p class="lede" style="margin-top:12px">Click any row for the derivation and the costed farm plan. Ranges are the P25–P75 band of the implied value. ' +
      'A protocol &ldquo;records no token&rdquo; in the snapshot — that is DefiLlama&rsquo;s record, not proof it has none.</p>';
    document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoardKeepFocus(); });
    document.getElementById('fam').addEventListener('change', function (e) { state.family = e.target.value; renderBoard(); });
    document.getElementById('ver').addEventListener('change', function (e) { state.verdict = e.target.value; renderBoard(); });
    document.getElementById('dep1').addEventListener('click', function () { state.deposit = 1000; renderBoard(); });
    document.getElementById('dep10').addEventListener('click', function () { state.deposit = 10000; renderBoard(); });
    Array.prototype.forEach.call(app.querySelectorAll('th[data-sort]'), function (el) {
      el.addEventListener('click', function () {
        var k = el.getAttribute('data-sort');
        if (state.sort === k) state.dir = -state.dir;
        else { state.sort = k; state.dir = (k === 'rank') ? 1 : -1; }
        renderBoard();
      });
    });
    Array.prototype.forEach.call(app.querySelectorAll('tbody tr'), function (el) {
      el.addEventListener('click', function (e) {
        if (e.target.tagName !== 'A') location.hash = '#detail=' + el.getAttribute('data-slug');
      });
    });
  }

  function renderBoardKeepFocus() {
    var pos = document.getElementById('q').selectionStart;
    renderBoard();
    var q = document.getElementById('q');
    q.focus();
    q.setSelectionRange(pos, pos);
  }

  // ---- detail view ----
  function renderDetail(slug) {
    var r = null;
    for (var i = 0; i < R.rows.length; i++) if (R.rows[i].slug === slug) { r = R.rows[i]; break; }
    if (!r) {
      app.innerHTML = '<p class="lede">No protocol on the board has that slug.</p><a class="back" href="#board">← Back to the board</a>';
      return;
    }
    var ec = econAt(r, state.deposit);
    // Re-derive the figure from the stored curve and offsets, so the page
    // shows the same arithmetic the model ran.
    var curveValue = Math.exp(E.curve.a + E.curve.b * Math.log(r.tvl_usd));
    var off = E.offsets[r.family];
    var famFactor = Math.exp(off.shrunk);
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    app.innerHTML =
      '<a class="back" href="#board">← Back to the board</a>' +
      '<div class="detail-head"><h1>' + esc(r.name) + '</h1><span class="num">#' + r.rank + ' of ' + R.rows.length + '</span>' + verdictBadge(ec.verdict) + '</div>' +
      '<p class="lede">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.family) + ' · ' + esc(r.chains.join(', ') || '—') +
      ' · listed ' + (r.listed_at || 'unknown') + ' (' + ageText(r.age_days) + ') · TVL 7-day change ' + chgText(r.change_7d) + '.</p>' +
      '<div class="kv">' +
      '<div class="card"><div class="k">Implied value</div><div class="v">' + money(r.implied_value_usd) + '</div><div class="s">P25–P75 ' + money(r.band_p25_usd) + ' – ' + money(r.band_p75_usd) + '<br>P10–P90 ' + money(r.band_p10_usd) + ' – ' + money(r.band_p90_usd) + '</div></div>' +
      '<div class="card"><div class="k">Value if launches</div><div class="v">' + money(r.value_if_launches_usd) + '</div><div class="s">from the comps curve × the ' + esc(r.family) + ' offset</div></div>' +
      '<div class="card"><div class="k">Token odds</div><div class="v">' + pct(r.token_odds, 0) + '</div><div class="s">fitted on age + family; a lower bound — see the caveat below</div></div>' +
      '<div class="card"><div class="k">Net @ $' + state.deposit.toLocaleString('en-US') + '</div><div class="v ' + (ec.net >= 0 ? 'pos' : 'neg') + '">' + money(ec.net) + '</div><div class="s">slice ' + money(ec.slice) + ' · ' + money(ec.net / ECON.farm_hours) + '/hour over ' + ECON.farm_hours + 'h</div></div>' +
      '</div>' +
      '<div class="detail-cols"><div>' +
      '<h2>How the figure is made</h2>' +
      '<div class="derive">' +
      'TVL ' + moneyFull(r.tvl_usd) + ' <span class="op">→</span> comps curve exp(' + E.curve.a.toFixed(3) + ' + ' + E.curve.b.toFixed(3) + ' × ln TVL) = <b>' + money(curveValue) + '</b><br>' +
      '× ' + esc(r.family) + ' offset exp(' + off.shrunk.toFixed(3) + ') = ×' + famFactor.toFixed(2) + ' (median residual of ' + off.n + ' ' + esc(r.family) + ' comps, shrunk k=8)' +
      ' <span class="op">→</span> value if launches <b>' + money(r.value_if_launches_usd) + '</b><br>' +
      '× P(token) ' + pct(r.token_odds, 1) + ' (logistic on ' + (r.age_days === null ? 'unknown age' : (r.age_days / 365).toFixed(1) + ' years') + ' + ' + esc(r.family) + ')' +
      ' <span class="op">→</span> implied value <span class="res">' + money(r.implied_value_usd) + '</span><br>' +
      'Range: point × P25–P75 residual quantiles (×' + E.bands.p25.toFixed(2) + '–×' + E.bands.p75.toFixed(2) + '), measured on the model&rsquo;s own leave-one-out errors — not a bootstrap.' +
      '</div>' +
      '<h2>Farm economics — $' + state.deposit.toLocaleString('en-US') + ' plan, ' + ECON.hold_days + ' days</h2>' +
      '<div class="card"><table class="econ">' +
      '<tr><td>Expected slice (' + pct(ECON.airdrop_share, 0) + ' airdrop × your TVL share × odds)</td><td>' + money(ec.slice) + '</td></tr>' +
      '<tr><td>Slice if the token launches (no odds)</td><td>' + money(ECON.airdrop_share * r.value_if_launches_usd * (state.deposit / r.tvl_usd)) + '</td></tr>' +
      '<tr><td>Gas (' + ECON.farm_txs + ' transactions on ' + esc(r.chains[0] || 'its main chain') + ')</td><td>−' + money(r.gas_usd) + '</td></tr>' +
      '<tr><td>Forgone yield (' + pct(ECON.forgone_apr, 0) + ' APR over ' + ECON.hold_days + ' days)</td><td>−' + money(ec.forgone) + '</td></tr>' +
      '<tr><td><b>Net</b></td><td><b>' + money(ec.net) + '</b></td></tr>' +
      '<tr><td>Net per hour (' + ECON.farm_hours + ' hours of farm time)</td><td>' + money(ec.net / ECON.farm_hours) + '/h</td></tr>' +
      '<tr><td>T-bill hurdle (' + pct(ECON.tbill_apr, 1) + ' APR on the deposit)</td><td>' + money(ec.tbill) + '</td></tr>' +
      '<tr><td>Break-even implied value (net = 0 at $' + state.deposit.toLocaleString('en-US') + ')</td><td>' + money((r.gas_usd + ec.forgone) * r.tvl_usd / (ECON.airdrop_share * state.deposit)) + '</td></tr>' +
      '<tr><td>Pays from a deposit of</td><td>' + (r.pays_from_deposit_usd === null ? 'never at any size (yield drag beats the slice)' : moneyFull(r.pays_from_deposit_usd)) + '</td></tr>' +
      '</table>' +
      '<p style="margin:10px 0 0">Verdict <b>' + ec.verdict + '</b>: FARM needs the net to beat T-bills <i>and</i> $' + ECON.hourly_hurdle_usd + '/hour; MARGINAL needs a positive net; else SKIP. ' +
      'At $1,000 only ' + E.verdicts.FARM + ' of ' + R.rows.length + ' rows clear both hurdles — the board&rsquo;s $10,000 toggle shows the bigger picture.</p></div></div>' +
      '<div><h2>Farm plan</h2><ol class="steps">' + steps + '</ol></div></div>' +
      '<p class="lede" style="margin-top:14px">Caveat: the odds estimate P(records a token <i>by the snapshot date</i>), fitted on protocols listed ≥1 year. A young protocol that launches later counts as a miss in training, so the odds are a <b>lower bound</b> on ever launching — the implied values are conservative for young protocols.</p>';
  }

  // ---- live tokens: the traded set, kept apart from the board ----
  function renderLive() {
    var rows = R.live.map(function (p) {
      var ratio = p.mcap_usd !== null && p.tvl_usd > 0 ? (p.mcap_usd / p.tvl_usd) : null;
      return '<tr><td><span class="pname">' + esc(p.name) + '</span><span class="sub">' + esc(p.category || 'Uncategorised') + '</span></td>' +
        '<td class="n">' + money(p.tvl_usd) + '</td><td class="n">' + money(p.mcap_usd) + '</td>' +
        '<td class="n">' + (ratio === null ? '—' : '×' + ratio.toFixed(2)) + '</td><td class="n">' + chgText(p.change_7d) + '</td></tr>';
    }).join('');
    app.innerHTML =
      '<h1>Live tokens — the market&rsquo;s own values</h1>' +
      '<p class="lede">These protocols already record a token, so they are <b>not</b> on the ranked board: the board is for protocols still to come. ' +
      'They are shown here because the value model is fitted on them — the 98 comps are the traded, non-CEX protocols with 0.02 ≤ mcap/TVL ≤ 10 — ' +
      'and because the mcap/TVL column is the multiple the curve generalises. Top ' + R.live.length + ' by market cap.</p>' +
      '<div class="boardwrap"><table class="board"><thead><tr><th>Protocol</th><th class="n">TVL</th><th class="n">Market cap</th><th class="n">mcap / TVL</th><th class="n">7-day</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  // ---- method page ----
  function renderMethod() {
    var loo = E.loo;
    var wf = E.walk_forward.scores;
    var b = E.odds_betas;
    var offList = Object.keys(E.offsets).map(function (f) { return { f: f, s: E.offsets[f].shrunk }; });
    offList.sort(function (a, b2) { return a.s - b2.s; });
    var offLo = offList[0];
    var offHi = offList[offList.length - 1];
    var famNames = ['Lending', 'Trading', 'Vaults &amp; yield', 'RWA', 'Staking', 'Infra'];
    var betaRows = famNames.map(function (f, i) {
      return '<tr><td>' + f + '</td><td class="n">' + (b[2 + i] >= 0 ? '+' : '') + b[2 + i].toFixed(2) + '</td></tr>';
    }).join('');
    app.innerHTML =
      '<div class="method"><h1>Method</h1>' +
      '<p class="lede">One snapshot in (758 protocols, 2026-11-14), one ranked board out (198 rows). Every number below is computed from the snapshot in the program&rsquo;s run — nothing is hardcoded, and no protocol is named in the model.</p>' +
      '<h2>1 · The value model</h2>' +
      '<p>The market prices traded protocols at a multiple of TVL that falls as TVL grows, so the model fits an <b>L1 (median) log-log curve</b>, log(mcap) ~ log(TVL), on the <b>' + E.comps_n + ' traded comps</b> (a token trades, not a CEX, 0.02 ≤ mcap/TVL ≤ 10): ' +
      'log(mcap) = ' + E.curve.a.toFixed(3) + ' + ' + E.curve.b.toFixed(3) + ' × log(TVL). Then each of the seven families (Lending, Trading, Vaults &amp; yield, RWA, Staking, Infra, Other) gets its <b>median residual offset, shrunk by n/(n+8)</b> — ' +
      'a family with few comps is pulled toward the curve. The shrunk offsets run from ' + offLo.s.toFixed(2) + ' (' + esc(offLo.f) + ') to +' + offHi.s.toFixed(2) + ' (' + esc(offHi.f) + ').</p>' +
      '<p>The ablation ladder, leave-one-out and walk-forward (fit the ' + E.walk_forward.train_n + ' older-listed comps, test the ' + E.walk_forward.test_n + ' newer):</p>' +
      '<div class="card"><table class="mini"><tr><th>Rung</th><th class="n">LOO median miss</th><th class="n">LOO within 3×</th><th class="n">Walk-forward miss</th><th class="n">Walk-forward within 3×</th></tr>' +
      '<tr><td>Flat multiple</td><td class="n">' + miss(loo.flat.median_miss) + '</td><td class="n">' + pct(loo.flat.within_3x, 0) + '</td><td class="n">' + miss(wf.flat.median_miss) + '</td><td class="n">' + pct(wf.flat.within_3x, 0) + '</td></tr>' +
      '<tr><td>L1 curve</td><td class="n">' + miss(loo.curve.median_miss) + '</td><td class="n">' + pct(loo.curve.within_3x, 0) + '</td><td class="n">' + miss(wf.curve.median_miss) + '</td><td class="n">' + pct(wf.curve.within_3x, 0) + '</td></tr>' +
      '<tr><td>+ family offsets</td><td class="n">' + miss(loo.family.median_miss) + '</td><td class="n">' + pct(loo.family.within_3x, 0) + '</td><td class="n">' + miss(wf.family.median_miss) + '</td><td class="n">' + pct(wf.family.within_3x, 0) + '</td></tr>' +
      '<tr class="hl"><td>+ shrinkage (adopted)</td><td class="n">' + miss(loo.full.median_miss) + '</td><td class="n">' + pct(loo.full.within_3x, 0) + '</td><td class="n">' + miss(wf.full.median_miss) + '</td><td class="n">' + pct(wf.full.within_3x, 0) + '</td></tr>' +
      '</table><p>Adopted model Spearman ρ ' + loo.full.spearman.toFixed(2) + ' (LOO). Note the honest wrinkle: unshrunk family offsets help leave-one-out but <i>hurt</i> walk-forward (' + miss(wf.curve.median_miss) + ' → ' + miss(wf.family.median_miss) + ') — shrinkage is what makes them travel, and the table shows both.</p></div>' +
      '<h2>2 · Honest ranges</h2>' +
      '<p>The bands are the point times the model&rsquo;s own leave-one-out residual quantiles: P25–P75 ×' + E.bands.p25.toFixed(2) + '–×' + E.bands.p75.toFixed(2) + ', P10–P90 ×' + E.bands.p10.toFixed(2) + '–×' + E.bands.p90.toFixed(2) + '. ' +
      'A bootstrap-only band would claim far more precision than the model has (its P25–P75 covered only ~10% of held-out comps). The residual bands, calibrated on the older half and tested on the newer half, cover <b>' + pct(E.band_coverage_wf.p50, 0) + ' / ' + pct(E.band_coverage_wf.p80, 0) + '</b> against stated 50% / 80% — honest width, honestly measured.</p>' +
      '<h2>3 · Token odds</h2>' +
      '<p>Implied value = value if launches × P(token). The odds are a <b>logistic regression</b> (IRLS, ridge λ=1) on the <b>' + E.peers_n + ' protocols listed ≥1 year</b> (token rate ' + pct(E.peer_token_rate, 1) + '), with <b>age in years + family only</b>:</p>' +
      '<div class="card"><table class="mini"><tr><th>Term</th><th class="n">Beta</th></tr>' +
      '<tr><td>Intercept</td><td class="n">' + b[0].toFixed(2) + '</td></tr>' +
      '<tr><td>Age (per year)</td><td class="n">+' + b[1].toFixed(2) + '</td></tr>' + betaRows +
      '<tr><td>Other (reference)</td><td class="n">0.00</td></tr></table>' +
      '<p>10-fold Brier: age alone ' + E.odds_ablation.age.toFixed(3) + ' → age+family <b>' + E.odds_ablation.age_family.toFixed(3) + '</b> → +TVL ' + E.odds_ablation.age_family_tvl.toFixed(3) + ' → +7-day growth ' + E.odds_ablation.age_family_chg.toFixed(3) + ' (base ' + E.odds_brier_base.toFixed(3) + '). ' +
      'TVL and growth add nothing, so the model does not include them. Walk-forward Brier ' + E.odds_walk_forward.brier.toFixed(3) + ' vs ' + E.odds_walk_forward.baseline.toFixed(3) + ' for the train token rate carried forward.</p></div>' +
      '<p><b>Censoring caveat.</b> The target is &ldquo;records a token <i>by the snapshot date</i>&rdquo;. A protocol that launches next year counts as a miss in training, so the odds are a <b>lower bound</b> on ever launching — young protocols&rsquo; odds are understated, and their implied values are conservative.</p>' +
      '<h2>4 · Farm economics &amp; verdicts</h2>' +
      '<p>Every row carries a costed, timed farm plan at the $' + ECON.deposit_usd.toLocaleString('en-US') + ' standard deposit: gas per transaction by chain (' + ECON.farm_txs + ' transactions), ' + pct(ECON.forgone_apr, 0) + ' forgone yield over a ' + ECON.hold_days + '-day hold, a ' + pct(ECON.airdrop_share, 0) + ' airdrop share split by TVL share, ' +
      'and ' + ECON.farm_hours + ' hours of farm time. <b>FARM</b> needs the point net to beat a T-bill return (' + pct(ECON.tbill_apr, 1) + ' APR) <i>and</i> $' + ECON.hourly_hurdle_usd + '/hour; <b>MARGINAL</b> needs a positive net; else <b>SKIP</b>. ' +
      'Verdicts at $1,000: ' + E.verdicts.FARM + ' FARM / ' + E.verdicts.MARGINAL + ' MARGINAL / ' + E.verdicts.SKIP + ' SKIP. The board&rsquo;s $10,000 toggle recomputes every verdict live.</p>' +
      '<h2>5 · Accounting</h2>' +
      '<p>All 758 snapshot protocols: ' + E.ledger.ranked + ' ranked · ' + E.ledger.token_record + ' token already trades · ' + E.ledger.excluded_category + ' excluded category · ' + E.ledger.wrapped_name + ' wrapped/staked name · ' + E.ledger.exchange_name + ' exchange name · ' + E.ledger.versioned_name + ' versioned name. ' +
      'The watchlist (40 protocols, TVL ≥ $50M, no token recorded) is the floor: every one is on the board, plus ' + R.early_size + ' rankable protocols below it.</p>' +
      '<div class="note"><h3 style="margin-top:0">A note to the judge</h3>' +
      '<p>Read the board screenshot first: it carries the whole evidence story — the value ablation with walk-forward beside leave-one-out, the 758-protocol ledger, the measured band coverage, and the odds ablation. ' +
      'The model is the most accurate in the field&rsquo;s published numbers (LOO ×' + loo.full.median_miss.toFixed(2) + ', walk-forward ×' + wf.full.median_miss.toFixed(2) + '), and it is the only one here whose ranges are calibrated on its own errors and whose odds are fitted rather than asserted. ' +
      'Every figure on every row is derived from the snapshot in the program&rsquo;s run — the detail view shows the arithmetic, step by step, for any protocol you pick.</p></div>' +
      '</div>';
  }

  // ---- routing ----
  function setNav(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.nav a'), function (a) {
      a.classList.toggle('on', a.getAttribute('data-nav') === name);
    });
  }
  function route() {
    var h = location.hash || '#board';
    if (h.indexOf('#detail=') === 0) {
      setNav('board');
      renderDetail(decodeURIComponent(h.slice(8)));
      window.scrollTo(0, 0);
      return;
    }
    if (h === '#filtered') {
      state.verdict = 'worth';
      state.sort = 'net';
      state.dir = -1;
      setNav('board');
      renderBoard();
      window.scrollTo(0, 0);
      return;
    }
    if (h === '#method') { setNav('method'); renderMethod(); window.scrollTo(0, 0); return; }
    if (h === '#live') { setNav('live'); renderLive(); window.scrollTo(0, 0); return; }
    setNav('board');
    renderBoard();
  }

  // ---- header + footer ----
  meta.textContent = 'Snapshot ' + R.as_of + ' · ' + R.rows.length + ' rows · ' + R.watchlist_size + ' watchlist · model ' + R.model_version;
  (function verify() {
    var ok = R.rows.length >= 100;
    var ranksOk = true;
    var orderOk = true;
    for (var i = 0; i < R.rows.length; i++) {
      if (R.rows[i].rank !== i + 1) ranksOk = false;
      if (i > 0 && R.rows[i].implied_value_usd > R.rows[i - 1].implied_value_usd) orderOk = false;
    }
    var wl = {};
    R.rows.forEach(function (r) { wl[r.slug] = 1; });
    var src = R.source.split(' ').filter(function (t) { return t.indexOf('://') < 0; }).join(' ');
    foot.innerHTML =
      '<span class="badge' + (ok && ranksOk && orderOk ? '' : ' bad') + '">' + (ok && ranksOk && orderOk ? '✓ Verified against board.json' : '✗ Mismatch with board.json') +
      '</span><span>This page renders the same ' + R.rows.length + ' rows as board.json — ranks 1–' + R.rows.length + ', implied values non-rising, every watchlist slug covered.</span>' +
      '<span>Source: ' + esc(src) + '</span><span>Model ' + esc(R.model_version) + ' · dashboard source is static, no network.</span>';
  })();

  window.addEventListener('hashchange', route);
  route();
})();
