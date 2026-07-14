// Renders window.CERNERE_API into toggle-expandable groups with search + filter.
(function () {
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function methodBadge(m) {
    var cls = m === "GET" ? "get" : m === "POST" ? "post" : "ws";
    return '<span class="badge ' + cls + '">' + esc(m) + "</span>";
  }
  function authBadge(a) {
    var cls = /public|—/.test(a) ? "public" : "auth";
    return '<span class="badge ' + cls + '">' + esc(a) + "</span>";
  }
  function paramTable(title, rows) {
    if (!rows || !rows.length) return "";
    var body = rows.map(function (p) {
      var req = p.r
        ? '<span class="req">必須</span>'
        : '<span class="opt">任意</span>';
      return "<tr><td>" + esc(p.n) + "</td><td><code>" + esc(p.t) + "</code></td><td>" +
        req + "</td><td>" + esc(p.d) + "</td></tr>";
    }).join("");
    return "<h4>" + title + "</h4><table class=\"param-table\"><thead><tr>" +
      "<th>名前</th><th>型</th><th>必須</th><th>説明</th></tr></thead><tbody>" +
      body + "</tbody></table>";
  }
  function endpointHTML(ep) {
    var hay = (ep.method + " " + ep.path + " " + ep.summary + " " + ep.auth + " " +
      (ep.body || []).map(function (b) { return b.n; }).join(" ") + " " +
      (ep.params || []).map(function (b) { return b.n; }).join(" ")).toLowerCase();
    var kind = ep.method === "WS" ? "ws" : "rest";

    var body = "";
    body += paramTable("クエリ / パスパラメータ", ep.params);
    body += paramTable(kind === "ws" ? "ペイロード" : "リクエストボディ", ep.body);
    if (ep.returns) body += "<h4>レスポンス</h4><pre><code>" + esc(ep.returns) + "</code></pre>";
    if (ep.notes && ep.notes.length) {
      body += "<h4>補足</h4><ul>" + ep.notes.map(function (n) {
        return "<li>" + esc(n) + "</li>";
      }).join("") + "</ul>";
    }

    return '<details class="api" data-kind="' + kind + '" data-hay="' + esc(hay) + '">' +
      "<summary>" + methodBadge(ep.method) +
      '<span class="summary-path">' + esc(ep.path) + "</span>" +
      authBadge(ep.auth) +
      '<span class="summary-desc">' + esc(ep.summary) + "</span>" +
      '<span class="chev">▸</span>' +
      "</summary>" +
      '<div class="api-body">' + body + "</div></details>";
  }
  function groupHTML(g) {
    return '<section class="api-group" data-group>' +
      "<h2>" + esc(g.group) + "</h2>" +
      (g.desc ? '<p class="group-desc">' + esc(g.desc) + "</p>" : "") +
      g.endpoints.map(endpointHTML).join("") +
      "</section>";
  }

  document.addEventListener("DOMContentLoaded", function () {
    var root = document.getElementById("api-root");
    root.innerHTML = (window.CERNERE_API || []).map(groupHTML).join("");

    var search = document.getElementById("search");
    var empty = document.getElementById("empty");
    var activeFilter = "all";

    function apply() {
      var q = (search.value || "").trim().toLowerCase();
      var anyVisible = false;
      document.querySelectorAll("[data-group]").forEach(function (grp) {
        var groupVisible = false;
        grp.querySelectorAll("details.api").forEach(function (d) {
          var matchKind = activeFilter === "all" || d.dataset.kind === activeFilter;
          var matchText = !q || d.dataset.hay.indexOf(q) !== -1;
          var show = matchKind && matchText;
          d.style.display = show ? "" : "none";
          if (show) { groupVisible = true; anyVisible = true; }
        });
        grp.style.display = groupVisible ? "" : "none";
      });
      empty.style.display = anyVisible ? "none" : "";
    }

    search.addEventListener("input", apply);
    document.querySelectorAll("[data-filter]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        activeFilter = btn.dataset.filter;
        apply();
      });
    });
    document.getElementById("expand").addEventListener("click", function () {
      document.querySelectorAll("details.api").forEach(function (d) {
        if (d.style.display !== "none") d.open = true;
      });
    });
    document.getElementById("collapse").addEventListener("click", function () {
      document.querySelectorAll("details.api").forEach(function (d) { d.open = false; });
    });

    apply();
  });
})();
