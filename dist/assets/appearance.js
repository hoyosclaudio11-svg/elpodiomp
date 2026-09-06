const preferenceKey = 'elpodio-theme';

export function initAppearance() {
  const root = document.documentElement;
  const button = document.getElementById('theme-toggle');
  function applyTheme(theme) {
    const light = theme === 'light';
    root.dataset.theme = light ? 'light' : 'dark';
    root.style.colorScheme = root.dataset.theme;
    button.setAttribute('aria-checked', String(light));
    button.title = light ? 'Activar modo oscuro' : 'Activar modo claro';
    button.querySelector('.theme-label').textContent = light ? 'Claro' : 'Oscuro';
    document.querySelector('meta[name="theme-color"]').content = light ? '#f6f5f0' : '#07070c';
    document.dispatchEvent(new Event('podio-theme-change'));
  }
  applyTheme(root.dataset.theme);
  button.addEventListener('click', () => {
    applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
    try { localStorage.setItem(preferenceKey, root.dataset.theme); } catch { /* Theme still works without storage. */ }
  });
  window.addEventListener('storage', event => {
    if (event.key === preferenceKey || event.key === null) applyTheme(event.newValue === 'light' ? 'light' : 'dark');
  });
  initParticles();
}

function initParticles() {
  const canvas = document.getElementById('background-particles');
  const context = canvas.getContext('2d');
  if (!context) { canvas.hidden = true; return; }
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0, height = 0, particles = [], frame = 0, previous = 0;
  let colors = [], light = false;
  function palette() {
    const css = getComputedStyle(document.documentElement);
    colors = [css.getPropertyValue('--particle-a').trim(),css.getPropertyValue('--particle-b').trim()];
    light = document.documentElement.dataset.theme === 'light';
  }
  function resize() {
    width = innerWidth; height = innerHeight;
    const ratio = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    context.setTransform(ratio,0,0,ratio,0,0);
    const count = width < 768 ? 22 : Math.min(62, Math.round(width*height/22000));
    particles = Array.from({ length:count }, (_,i) => ({x:Math.random()*width, y:Math.random()*height, radius:.7+Math.random()*1.4, vx:(Math.random()-.5)*5, vy:-3-Math.random()*7, phase:Math.random()*Math.PI*2, color:i%2}));
  }
  function draw(now) {
    frame = 0;
    if(document.hidden || motion.matches) return;
    if(now-previous < 32) { frame=requestAnimationFrame(draw); return; }
    const delta = previous ? Math.min((now-previous)/1000,.08) : 0;
    previous=now;
    context.clearRect(0,0,width,height);
    for(const p of particles) {
      p.x += p.vx*delta; p.y += p.vy*delta;
      if(p.y < -12) p.y=height+12;
      if(p.x < -12) p.x=width+12;
      if(p.x > width+12) p.x=-12;
      const alpha=(light ? .26 : .38)+Math.sin(now*.00055+p.phase)*.1;
      context.beginPath();
      context.arc(p.x,p.y,p.radius,0,Math.PI*2);
      context.fillStyle=`rgba(${colors[p.color]},${alpha})`;
      context.fill();
      // A diffuse halo keeps the particles soft around photos and type.
      const halo=context.createRadialGradient(p.x,p.y,0,p.x,p.y,p.radius*5);
      halo.addColorStop(0,`rgba(${colors[p.color]},${alpha*.16})`);
      halo.addColorStop(1,`rgba(${colors[p.color]},0)`);
      context.fillStyle=halo;
      context.fillRect(p.x-p.radius*5,p.y-p.radius*5,p.radius*10,p.radius*10);
    }
    frame=requestAnimationFrame(draw);
  }
  function sync() {
    cancelAnimationFrame(frame); frame=0; previous=0;
    canvas.hidden=motion.matches;
    if(!document.hidden && !motion.matches) frame=requestAnimationFrame(draw);
  }
  palette(); resize(); sync();
  addEventListener('resize',resize,{passive:true});
  document.addEventListener('podio-theme-change',palette);
  document.addEventListener('visibilitychange',sync);
  motion.addEventListener('change',sync);
  addEventListener('pagehide',()=>cancelAnimationFrame(frame));
  addEventListener('pageshow',sync);
}
