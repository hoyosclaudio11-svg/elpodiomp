import { initAppearance } from './assets/appearance.js';

export const groups = {
  todos: { name: 'Todo', icon: 'layout-grid' },
  zapatillas: { name: 'Zapatillas', icon: 'footprints' },
  tecnologia: { name: 'Tecnología', icon: 'smartphone' },
  audio: { name: 'Audio', icon: 'headphones' },
  gaming: { name: 'Gaming', icon: 'gamepad-2' },
  hogar: { name: 'Hogar', icon: 'house' },
  accesorios: { name: 'Accesorios', icon: 'backpack' },
  deportes: { name: 'Deportes', icon: 'bike' }
};
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = (name, cls = 'w-4 h-4') => `<i data-lucide="${name}" class="${cls}" aria-hidden="true"></i>`;
const fmt = value => '$ ' + Number(value).toLocaleString('es-AR');
const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function safeURL(raw, image = false) {
  try {
    const url = new URL(raw);
    const validHost = image ? /(^|\.)mlstatic\.com$/.test(url.hostname) : /(^|\.)(mercadolibre\.com\.ar|meli\.la|mercadolib\.re)$/.test(url.hostname);
    return url.protocol === 'https:' && validHost && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function initialProducts(data) {
  const picked = ['zapatillas','tecnologia','audio','gaming'].flatMap(g=>data.products.filter(p=>p.group === g).slice(0,3));
  return picked;
}
function outgoing(p, cls, compact = false) {
  const url = safeURL(p.url);
  if (!url) return '<span class="text-[12px] text-white/50">Enlace no disponible</span>';
  const destination = p.destination === 'category' ? 'Explorar esta categoría en Mercado Libre' : 'Ver este producto en Mercado Libre';
  return `<a href="${escapeHTML(url)}" target="_blank" rel="sponsored noopener noreferrer" class="${cls}" aria-label="${escapeHTML(destination + ': ' + p.name + ' (abre en otra pestaña)')}" title="${destination}">${compact ? '' : 'Ver en Mercado Libre'} ${icon('arrow-up-right')}</a>`;
}
function photo(p, extra = '') {
  const src = safeURL(p.image,true);
  return `<div class="product-photo relative overflow-hidden ${extra}">${src ? `<img src="${escapeHTML(src)}" alt="${escapeHTML(p.name)}" loading="lazy" class="pimg w-full h-full" referrerpolicy="no-referrer">` : '<span class="image-fallback">Imagen no disponible</span>'}</div>`;
}
export function card(p,data,mode='uniform') {
  const category = data.categories.find(c=>c.id===p.category)?.name || groups[p.group]?.name || 'Productos';
  const medal = `<span class="medal medal-${p.rank} w-9 h-9 text-[15px] shrink-0" title="Posición en nuestra selección">${p.rank}</span>`;
  const hint = p.destination === 'category' ? 'Explorá opciones en Mercado Libre' : 'Consultá la publicación en Mercado Libre';
  if(mode === 'small') return `<article class="pcard small-product flex items-stretch gap-4 p-3.5">${photo(p,'w-[96px] sm:w-[112px] shrink-0 rounded-2xl min-h-[160px]')}<div class="flex-1 min-w-0 py-1.5 pr-1 flex flex-col gap-2"><div class="flex items-center gap-2">${medal}<span class="text-[10px] text-white/45 uppercase">Selección</span></div><h3 class="product-title font-disp font-bold text-[14px] leading-snug">${escapeHTML(p.name)}</h3><div class="mt-auto flex flex-wrap items-center justify-between gap-2"><div><span class="block text-[10px] text-white/45">Precio de referencia</span><span class="font-disp font-bold text-[16px] text-[#c8ff3e]">${fmt(p.price)}</span></div>${outgoing(p,'btn-lime !p-3 shrink-0',true)}</div></div></article>`;
  if(mode === 'featured') return `<article class="pcard md:col-span-2 flex flex-col sm:flex-row">${photo(p,'sm:w-[45%] shrink-0 min-h-[280px] sm:min-h-full')}<div class="p-6 md:p-8 flex flex-col gap-5 flex-1 min-w-0"><div class="flex items-center gap-3">${medal}<div><div class="text-[#f5c542] font-disp font-bold text-[12px] tracking-widest">EN NUESTRO PODIO</div><div class="text-[11px] text-white/45 mt-1">${escapeHTML(category)}</div></div></div><h3 class="font-disp font-bold text-[clamp(1.3rem,2.1vw,1.8rem)] leading-tight">${escapeHTML(p.name)}</h3><p class="text-[13px] text-white/55 leading-relaxed">${hint}. Allí podés revisar las características, el precio vigente y las condiciones del vendedor.</p><div class="mt-auto"><p class="text-[11px] text-white/45 mb-1">Precio de referencia</p><p class="font-disp font-bold text-[29px] text-[#c8ff3e]">${fmt(p.price)}</p>${outgoing(p,'btn-lime px-5 py-3 mt-5 text-[13px] w-full')}</div></div></article>`;
  return `<article class="pcard group flex flex-col" data-product="${escapeHTML(p.id)}"><div class="relative">${photo(p,'aspect-square')}<div class="absolute top-3.5 left-3.5">${medal}</div><span class="glass-chip px-3 py-1.5 text-[10px] font-disp font-semibold tracking-widest text-white/90 !bg-[#15151f]/85 absolute top-3.5 right-3.5 uppercase">${groups[p.group].name}</span></div><div class="p-5 flex flex-col gap-2.5 flex-1"><div class="text-[10px] font-disp font-semibold tracking-[.12em] text-white/45 uppercase">${escapeHTML(category)}</div><h3 class="product-title font-disp font-bold text-[16px] leading-snug">${escapeHTML(p.name)}</h3><div class="mt-auto pt-2"><span class="block text-[10px] text-white/45">Precio de referencia</span><span class="font-disp font-bold text-[21px] text-[#c8ff3e] tracking-tight">${fmt(p.price)}</span></div>${outgoing(p,'btn-lime w-full py-3 text-[12px] mt-2')}<p class="text-[10px] text-white/45 text-center">${hint}</p></div></article>`;
}

if (typeof document !== 'undefined') init();
function init() {
  initAppearance();
  const data = JSON.parse(document.getElementById('catalog-data').textContent);
  const grid = document.getElementById('grid');
  const search = document.getElementById('search');
  const subcategory = document.getElementById('subcategory');
  const more = document.getElementById('load-more');
  const status = document.getElementById('catalog-status');
  let active = 'todos', expanded = false;
  const icons = () => window.lucide?.createIcons();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function enhanceImages() {
    grid.querySelectorAll('img').forEach(img => {
      const fallback = () => { img.hidden = true; if(!img.parentElement.querySelector('.image-fallback')) { const label = document.createElement('span'); label.className = 'image-fallback'; label.textContent = 'Imagen no disponible · Ver en Mercado Libre'; img.parentElement.append(label); } };
      img.addEventListener('error',fallback,{once:true});
      if(img.complete && img.naturalWidth===0) fallback();
    });
  }
  function render() {
    const q = normalize(search.value.trim());
    let found = data.products.filter(p=>(active==='todos'||p.group===active) && (subcategory.value==='todos'||p.category===subcategory.value) && (!q||normalize(p.name+' '+data.categories.find(c=>c.id===p.category).name).includes(q)));
    const showPodium = !q && found.length === 3 && (active!=='todos'||subcategory.value!=='todos');
    const defaultView = active==='todos' && subcategory.value==='todos' && !q;
    let visible = defaultView ? [...initialProducts(data),...data.products.filter(p=>!initialProducts(data).some(x=>x.id===p.id))] : found;
    const paginated = !showPodium && !expanded && visible.length>12;
    if(paginated) visible = visible.slice(0,12);
    if(!found.length) {
      grid.innerHTML='<div class="pcard py-20 px-6 text-center"><span class="icon-tile mb-6 text-[#c8ff3e]">'+icon('search-x','w-6 h-6')+'</span><h3 class="font-disp font-bold text-xl mb-3">No encontramos productos</h3><p class="text-[14px] text-white/55 mb-7">Probá con otra palabra o explorá las categorías.</p><button id="reset-catalog" class="btn-ghost px-6 py-3">Ver todo el catálogo</button></div>';
      document.getElementById('reset-catalog').addEventListener('click',reset);
    } else if(showPodium) {
      grid.innerHTML=`<div class="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-5">${card(found[0],data,'featured')}<div class="flex flex-col gap-4 md:gap-5">${found.slice(1).map(p=>card(p,data,'small')).join('')}</div></div>`;
    } else grid.innerHTML=`<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-5">${visible.map(p=>card(p,data)).join('')}</div>`;
    more.hidden = !paginated;
    more.innerHTML = 'Ver más productos '+icon('arrow-down');
    status.textContent = !found.length ? 'Sin resultados' : `${visible.length} de ${found.length} productos${q ? ' encontrados' : ''}`;
    document.getElementById('result-bar').hidden = !q;
    document.getElementById('result-bar').classList.toggle('hidden',!q);
    document.getElementById('result-bar').classList.toggle('flex',!!q);
    document.getElementById('result-q').textContent = search.value.trim();
    document.getElementById('result-n').textContent = `${found.length} productos`;
    icons(); enhanceImages();
  }
  function selectGroup(id) {
    active=id; expanded=false; search.value='';
    subcategory.innerHTML='<option value="todos">Todas las categorías</option>'+data.categories.filter(c=>id==='todos'||c.group===id).map(c=>`<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('');
    document.querySelectorAll('[data-cat]').forEach(b=>{ b.classList.toggle('active',b.dataset.cat===id); b.setAttribute('aria-pressed',String(b.dataset.cat===id)); });
    render();
  }
  function reset() { selectGroup('todos'); search.focus(); }
  document.querySelectorAll('[data-cat]').forEach(btn=>btn.addEventListener('click',()=>selectGroup(btn.dataset.cat)));
  document.querySelectorAll('[data-explore]').forEach(a=>a.addEventListener('click',()=>selectGroup(a.dataset.explore)));
  search.addEventListener('input',()=>{expanded=false;render();});
  subcategory.addEventListener('change',()=>{expanded=false;render();});
  document.getElementById('clear-search').addEventListener('click',()=>{search.value='';expanded=false;render();search.focus();});
  more.addEventListener('click',()=>{ const firstNew=grid.querySelectorAll('article').length; expanded=true;render(); const target=grid.querySelectorAll('article')[firstNew]?.querySelector('a'); target?.focus({preventScroll:true}); });

  const menu = document.getElementById('mobile-menu');
  const menuButton = document.getElementById('menu-btn');
  const closeButton = document.getElementById('menu-close');
  function closeMenu(restore=true) { menu.classList.add('hidden'); menu.classList.remove('flex'); document.body.style.overflow=''; menuButton.setAttribute('aria-expanded','false'); if(restore) menuButton.focus(); }
  menuButton.addEventListener('click',()=>{menu.classList.remove('hidden');menu.classList.add('flex');document.body.style.overflow='hidden';menuButton.setAttribute('aria-expanded','true');closeButton.focus();});
  closeButton.addEventListener('click',()=>closeMenu());
  menu.querySelectorAll('.mm-link').forEach(a=>a.addEventListener('click',()=>{closeMenu(false);const target=document.querySelector(a.getAttribute('href'));target?.setAttribute('tabindex','-1');target?.focus({preventScroll:true});}));
  document.addEventListener('keydown',e=>{
    if(menu.classList.contains('hidden')) return;
    if(e.key==='Escape') closeMenu();
    if(e.key==='Tab') {const els=[...menu.querySelectorAll('a,button')]; const first=els[0],last=els.at(-1); if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
  });
  const desktop = matchMedia('(min-width:1024px)');
  desktop.addEventListener('change',e=>{if(e.matches&&!menu.classList.contains('hidden'))closeMenu(false);});
  const glow = document.getElementById('glow-follower');
  if(!reduced&&matchMedia('(hover:hover) and (pointer:fine)').matches) {
    addEventListener('pointermove',e=>{glow.style.transform=`translate(${e.clientX-170}px,${e.clientY-170}px)`;},{passive:true});
    grid.addEventListener('pointermove',e=>{ const el=e.target.closest('.pcard'); if(!el)return; const r=el.getBoundingClientRect(); el.style.setProperty('--mx',`${e.clientX-r.left}px`); el.style.setProperty('--my',`${e.clientY-r.top}px`); });
  }else glow.hidden=true;
  render(); icons();
  window.addEventListener('load',icons,{once:true});
}
