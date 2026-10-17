/* 利用規約ページ: 運営者名・担当課などを config.json から差し込む */
(function () {
  'use strict';
  function setAll(cls, text) {
    var list = document.getElementsByClassName(cls);
    for (var i = 0; i < list.length; i++) list[i].textContent = text;
  }
  fetch('config.json?t=' + Date.now())
    .then(function (r) { return r.ok ? r.json() : {}; })
    .catch(function () { return {}; })
    .then(function (c) {
      c = c || {};
      var t = c.terms || {};
      if (c.title) { setAll('t-site', c.title); document.title = '利用規約 - ' + c.title; }
      if (t.org) setAll('t-org', String(t.org));
      if (t.dept) setAll('t-dept', String(t.dept));
      if (t.contact) { document.getElementById('t-contact').textContent = String(t.contact); document.getElementById('t-contact-row').hidden = false; }
      if (t.date) { document.getElementById('t-date').textContent = String(t.date); document.getElementById('t-date-row').hidden = false; }
      if (t.extra) {   // 追記事項(1行 = 1段落)。文字として扱います
        var box = document.getElementById('t-extra');
        var lines = String(t.extra).split(/\r?\n/).filter(function (x) { return x.trim(); });
        if (lines.length) {
          var h = document.createElement('h2'); h.textContent = '追記事項'; box.appendChild(h);
          lines.forEach(function (ln) { var p = document.createElement('p'); p.textContent = ln; box.appendChild(p); });
        }
      }
    });
})();
