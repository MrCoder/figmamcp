// Figma MCP rate limit checker on /figma-mcp-rate-limit and its /ja/ and /zh/ translations.
// The page's static table is the source of truth: each tool row carries data-tool, data-kind (read|write)
// and data-counts (yes|no), and each plan <option> carries data-limit, data-period and, for paid Full or
// Dev seats, data-minute. This file holds no limit numbers. Without JavaScript the table still reads in full.
(function () {
  // Whole calls only; anything else (empty, negative, text) counts as 0.
  function parseCalls(value) {
    var n = Math.floor(Number(value));
    return isFinite(n) && n > 0 ? n : 0;
  }

  // rows: [{ tool, counts: boolean, calls: number }]; plan: { limit, period, minute? }
  function summarize(rows, plan) {
    var counted = 0, exempt = 0;
    rows.forEach(function (r) {
      if (r.counts) counted += r.calls; else exempt += r.calls;
    });
    return {
      counted: counted,
      exempt: exempt,
      limit: plan.limit,
      period: plan.period,
      minute: plan.minute || null,
      over: Math.max(0, counted - plan.limit),
      left: Math.max(0, plan.limit - counted)
    };
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // Visible text per page language (the <html lang> of /, /ja/ and /zh/ pages). English is the default.
  var STRINGS = {
    en: {
      period: { month: 'month', day: 'day' },
      column: 'Calls',
      label: function (tool, p) { return 'Calls to ' + tool + ' per ' + p; },
      counted: function (s) { return plural(s.counted, 'call counts', 'calls count') + ' toward the limit; ' + plural(s.exempt, 'call is', 'calls are') + ' exempt.'; },
      limit: function (s, p) { return 'Your limit: ' + s.limit + ' per ' + p + '.'; },
      over: function (s, p) { return 'That is ' + s.over + ' over the limit for one ' + p + '.'; },
      left: function (s, p) { return s.left + ' left for this ' + p + '.'; },
      minute: function (s) { return 'Separately, more than ' + s.minute + ' counted calls in any one minute go over the per-minute limit.'; },
      join: ' '
    },
    ja: {
      period: { month: 'か月', day: '日' },
      column: '呼び出し回数',
      label: function (tool, p) { return tool + 'の1' + p + 'あたりの呼び出し回数'; },
      counted: function (s) { return s.counted + '回が上限に含まれ、' + s.exempt + '回は対象外です。'; },
      limit: function (s, p) { return 'あなたの上限は1' + p + 'あたり' + s.limit + '回です。'; },
      over: function (s, p) { return '1' + p + 'の上限を' + s.over + '回超えています。'; },
      left: function (s, p) { return 'この1' + p + 'の残りは' + s.left + '回です。'; },
      minute: function (s) { return 'これとは別に、上限に含まれる呼び出しが1分間に' + s.minute + '回を超えると、1分あたりの上限を超えます。'; },
      join: ''
    },
    zh: {
      period: { month: '月', day: '天' },
      column: '调用次数',
      label: function (tool, p) { return tool + ' 每' + p + '的调用次数'; },
      counted: function (s) { return s.counted + ' 次调用计入限额；' + s.exempt + ' 次不计入。'; },
      limit: function (s, p) { return '你的限额：每' + p + ' ' + s.limit + ' 次。'; },
      over: function (s, p) { return '比每' + p + '的限额多出 ' + s.over + ' 次。'; },
      left: function (s, p) { return (p === '月' ? '本月' : '当天') + '还剩 ' + s.left + ' 次。'; },
      minute: function (s) { return '另外，任意一分钟内计入限额的调用超过 ' + s.minute + ' 次，就会超出每分钟限额。'; },
      join: ''
    }
  };

  // "ja", "zh-CN" and so on map to a STRINGS key; anything else is English.
  function locale(lang) {
    var key = String(lang || '').toLowerCase().split('-')[0];
    return STRINGS[key] ? key : 'en';
  }

  function message(s, lang) {
    var t = STRINGS[locale(lang)];
    var p = t.period[s.period] || s.period;
    var parts = [t.counted(s), t.limit(s, p)];
    parts.push(s.over > 0 ? t.over(s, p) : t.left(s, p));
    if (s.minute) parts.push(t.minute(s));
    return parts.join(t.join);
  }

  var api = { parseCalls: parseCalls, summarize: summarize, message: message, locale: locale };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  var box = document.getElementById('rl-checker');
  var table = document.getElementById('rl-tools');
  if (!box || !table || !document.getElementById('rl-plan') || !document.getElementById('rl-result')) return;
  var select = document.getElementById('rl-plan');
  var out = document.getElementById('rl-result');
  var periodLabels = box.querySelectorAll('[data-rl-period]');
  var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr[data-tool]'));
  var lang = document.documentElement.lang;
  var t = STRINGS[locale(lang)];

  var head = table.querySelector('thead tr');
  var th = document.createElement('th');
  th.scope = 'col';
  th.textContent = t.column;
  head.appendChild(th);

  var inputs = rows.map(function (tr) {
    var tool = tr.getAttribute('data-tool');
    var td = document.createElement('td');
    var label = document.createElement('label');
    label.className = 'sr';
    label.htmlFor = 'rl-n-' + tool;
    label.setAttribute('data-rl-tool', tool);
    var input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '1';
    input.inputMode = 'numeric';
    input.id = 'rl-n-' + tool;
    input.className = 'rl-calls';
    input.value = '0';
    td.appendChild(label);
    td.appendChild(input);
    tr.appendChild(td);
    return { tr: tr, input: input, label: label };
  });

  function plan() {
    var o = select.options[select.selectedIndex];
    return {
      limit: parseCalls(o.getAttribute('data-limit')),
      period: o.getAttribute('data-period'),
      minute: parseCalls(o.getAttribute('data-minute')) || null
    };
  }

  function update() {
    var p = plan();
    var word = t.period[p.period] || p.period;
    periodLabels.forEach(function (el) { el.textContent = word; });
    inputs.forEach(function (x) { x.label.textContent = t.label(x.tr.getAttribute('data-tool'), word); });
    var s = summarize(inputs.map(function (x) {
      return { tool: x.tr.getAttribute('data-tool'), counts: x.tr.getAttribute('data-counts') === 'yes', calls: parseCalls(x.input.value) };
    }), p);
    out.textContent = message(s, lang);
    out.classList.toggle('over', s.over > 0);
  }

  select.addEventListener('change', update);
  table.addEventListener('input', update);
  box.hidden = false;
  out.hidden = false;
  update();
})();
