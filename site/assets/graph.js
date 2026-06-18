// Builds the interactive domain/feature graph (vis-network) + accessible text fallback.
(function () {
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  document.addEventListener("DOMContentLoaded", function () {
    var G = window.CERNERE_GRAPH || { domains: [], deps: [] };
    var byId = {};
    G.domains.forEach(function (d) { byId[d.id] = d; });

    /* ---- text fallback (always rendered) ---- */
    document.getElementById("domain-list").innerHTML = G.domains.map(function (d) {
      return '<div class="card"><h3>' + (d.core ? "★ " : "") + esc(d.label) + "</h3><ul>" +
        d.features.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("") +
        "</ul></div>";
    }).join("");

    document.getElementById("dep-list").innerHTML =
      '<table><thead><tr><th>ドメイン</th><th>が依存する →</th></tr></thead><tbody>' +
      G.domains.map(function (d) {
        var targets = G.deps.filter(function (e) { return e[0] === d.id; })
          .map(function (e) { return (byId[e[1]] || {}).label || e[1]; });
        if (!targets.length) return "";
        return "<tr><td>" + esc(d.label) + "</td><td>" +
          targets.map(esc).join(" · ") + "</td></tr>";
      }).join("") + "</tbody></table>";

    /* ---- vis-network ---- */
    if (typeof vis === "undefined" || !vis.Network) {
      document.getElementById("fallback").style.display = "";
      document.getElementById("graph").style.display = "none";
      return;
    }

    var nodes = [];
    var edges = [];
    var featureIds = [];

    G.domains.forEach(function (d) {
      nodes.push({
        id: d.id,
        label: d.label,
        group: d.core ? "core" : "domain",
        value: d.core ? 30 : 18,
        font: { size: d.core ? 20 : 16, color: "#e6edf3", face: "system-ui" },
      });
      d.features.forEach(function (f, i) {
        var fid = d.id + "::f" + i;
        featureIds.push(fid);
        nodes.push({
          id: fid, label: f, group: "feature",
          value: 6, font: { size: 12, color: "#9aa7b4" },
        });
        edges.push({ from: d.id, to: fid, color: { color: "#2b3340" }, width: 1, smooth: false });
      });
    });

    G.deps.forEach(function (e) {
      edges.push({
        from: e[0], to: e[1], arrows: "to",
        color: { color: "#7d3b3b", highlight: "#f85149" },
        width: 1.5, smooth: { type: "curvedCW", roundness: 0.15 },
      });
    });

    var data = {
      nodes: new vis.DataSet(nodes),
      edges: new vis.DataSet(edges),
    };
    var options = {
      groups: {
        core: { shape: "dot", color: { background: "#DC2626", border: "#fca5a5" } },
        domain: { shape: "dot", color: { background: "#3b82f6", border: "#93c5fd" } },
        feature: { shape: "dot", color: { background: "#3a4250", border: "#525c6b" } },
      },
      nodes: { borderWidth: 1.5, scaling: { min: 6, max: 36 } },
      physics: {
        solver: "forceAtlas2Based",
        forceAtlas2Based: { gravitationalConstant: -60, springLength: 110, springConstant: 0.06 },
        stabilization: { iterations: 220 },
      },
      interaction: { hover: true, tooltipDelay: 120, navigationButtons: false },
    };

    var container = document.getElementById("graph");
    var network = new vis.Network(container, data, options);

    /* highlight neighbours on select */
    network.on("selectNode", function (params) {
      var sel = params.nodes[0];
      var connected = network.getConnectedNodes(sel).concat([sel]);
      var update = nodes.map(function (n) {
        var dim = connected.indexOf(n.id) === -1;
        return { id: n.id, opacity: dim ? 0.25 : 1 };
      });
      data.nodes.update(update);
    });
    network.on("deselectNode", function () {
      data.nodes.update(nodes.map(function (n) { return { id: n.id, opacity: 1 }; }));
    });

    /* controls */
    var featuresHidden = false;
    document.getElementById("toggle-features").addEventListener("click", function () {
      featuresHidden = !featuresHidden;
      data.nodes.update(featureIds.map(function (id) { return { id: id, hidden: featuresHidden }; }));
      this.textContent = featuresHidden ? "機能ノードを表示" : "機能ノードを隠す";
    });
    var physicsOn = true;
    document.getElementById("toggle-physics").addEventListener("click", function () {
      physicsOn = !physicsOn;
      network.setOptions({ physics: { enabled: physicsOn } });
      this.textContent = physicsOn ? "物理シミュレーション停止" : "物理シミュレーション再開";
    });
    document.getElementById("fit").addEventListener("click", function () {
      network.fit({ animation: true });
    });
  });
})();
