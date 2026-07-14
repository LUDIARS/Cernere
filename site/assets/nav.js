// Shared header / footer injection for the Cernere docs site.
(function () {
  var pages = [
    { href: "index.html", label: "概要" },
    { href: "graph.html", label: "ドメイングラフ" },
    { href: "api.html", label: "API リファレンス" },
    { href: "review.html", label: "仕様↔コード レビュー" },
  ];
  var here = (location.pathname.split("/").pop() || "index.html");
  if (here === "") here = "index.html";

  var links = pages
    .map(function (p) {
      var active = p.href === here ? ' class="active"' : "";
      return '<a href="' + p.href + '"' + active + ">" + p.label + "</a>";
    })
    .join("");

  var header =
    '<header class="site-header"><div class="nav-inner">' +
    '<a class="brand" href="index.html"><span class="logo">Cr</span>Cernere</a>' +
    '<nav class="nav-links">' + links + "</nav>" +
    "</div></header>";

  var footer =
    '<footer class="footer">Cernere — 汎用認証プラットフォーム &amp; データリレーサーバー · ' +
    'このサイトは <code>site/</code> 配下のソースから GitHub Pages にビルドされます · ' +
    '<a href="https://github.com/LUDIARS/Cernere">LUDIARS/Cernere</a></footer>';

  document.addEventListener("DOMContentLoaded", function () {
    document.body.insertAdjacentHTML("afterbegin", header);
    document.body.insertAdjacentHTML("beforeend", footer);
  });
})();
