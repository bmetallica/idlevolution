<script>
  // D2: Mini-Verlaufsgraph (Canvas, HiDPI-scharf). Autoskaliert; optional Null-Linie.
  export let data = [];
  export let color = '#7dd3a8';
  export let w = 88;
  export let h = 22;
  export let label = '';
  export let zeroLine = false; // Referenzlinie bei 0 (für Netto-Raten)

  let canvas;
  $: if (canvas && data) draw(data);

  function draw(values) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (values.length < 2) return;
    let min = Math.min(...values), max = Math.max(...values);
    if (zeroLine) { min = Math.min(min, 0); max = Math.max(max, 0); }
    if (max - min < 1e-9) { min -= 1; max += 1; }
    const X = (i) => 1 + (i / (values.length - 1)) * (w - 2);
    const Y = (v) => h - 2 - ((v - min) / (max - min)) * (h - 4);
    if (zeroLine && min < 0 && max > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0)); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.stroke();
    // Endpunkt markieren (aktueller Wert)
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(X(values.length - 1), Y(values[values.length - 1]), 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
</script>

<canvas bind:this={canvas} style="width:{w}px;height:{h}px" class="block" title={label}></canvas>
