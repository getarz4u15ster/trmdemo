/**
 * ABC Supermarkets – Mock Storefront
 * Solutions Architect Assessment App
 *
 * Run:
 *   npm install   (first time only)
 *   node app.js
 *
 * Then visit: http://localhost:3000
 * Make sure the InventorySoft mock API is running on http://localhost:3001
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const INVENTORYSOFT_BASE = process.env.INVENTORYSOFT_URL || "http://localhost:3001";

// ─── HTML App ─────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ABC Supermarkets</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet" />
  <style>
    /* ── Reset & Tokens ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --green:   #1a5c2e;
      --green2:  #2d8048;
      --cream:   #faf7f2;
      --warm:    #f5efe6;
      --red:     #c0392b;
      --gold:    #c8a84b;
      --text:    #1c1c1c;
      --muted:   #7a7265;
      --card-bg: #ffffff;
      --border:  #e4ddd3;
    }

    body {
      font-family: 'DM Sans', sans-serif;
      background: var(--cream);
      color: var(--text);
      min-height: 100vh;
    }

    /* ── Header ── */
    header {
      background: var(--green);
      padding: 0 2rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
      box-shadow: 0 2px 16px rgba(0,0,0,0.25);
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 1rem 0;
    }
    .logo-badge {
      width: 44px; height: 44px;
      background: var(--gold);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-family: 'Playfair Display', serif;
      font-weight: 900;
      font-size: 1.1rem;
      color: var(--green);
      flex-shrink: 0;
    }
    .logo-text {
      font-family: 'Playfair Display', serif;
      color: #fff;
      font-size: 1.3rem;
      font-weight: 700;
      line-height: 1.1;
    }
    .logo-text span { display: block; font-size: 0.7rem; font-weight: 400; letter-spacing: 0.12em; color: rgba(255,255,255,0.65); text-transform: uppercase; }

    .cart-btn {
      background: var(--gold);
      color: var(--green);
      border: none;
      border-radius: 28px;
      padding: 0.6rem 1.25rem;
      font-family: 'DM Sans', sans-serif;
      font-weight: 500;
      font-size: 0.9rem;
      cursor: pointer;
      display: flex; align-items: center; gap: 0.5rem;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .cart-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(0,0,0,0.2); }
    .cart-count {
      background: var(--green);
      color: #fff;
      border-radius: 50%;
      width: 20px; height: 20px;
      font-size: 0.7rem;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700;
    }

    /* ── Main layout ── */
    main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
    }

    /* ── Org tabs ── */
    .org-tabs {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 2rem;
      background: var(--warm);
      padding: 0.4rem;
      border-radius: 12px;
      border: 1px solid var(--border);
    }
    .org-tab {
      flex: 1;
      padding: 0.6rem 1rem;
      border: none;
      border-radius: 8px;
      background: transparent;
      cursor: pointer;
      font-family: 'DM Sans', sans-serif;
      font-size: 0.88rem;
      font-weight: 500;
      color: var(--muted);
      transition: all 0.2s;
    }
    .org-tab.active {
      background: var(--green);
      color: #fff;
      box-shadow: 0 2px 8px rgba(26,92,46,0.3);
    }

    /* ── Section heading ── */
    .section-heading {
      font-family: 'Playfair Display', serif;
      font-size: 1.6rem;
      margin-bottom: 1.25rem;
      color: var(--green);
    }

    /* ── Product Grid ── */
    .products-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
      gap: 1.25rem;
      margin-bottom: 3rem;
    }

    .product-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
      transition: transform 0.2s, box-shadow 0.2s;
      animation: fadeUp 0.35s ease both;
    }
    .product-card:hover { transform: translateY(-3px); box-shadow: 0 8px 24px rgba(0,0,0,0.09); }
    @keyframes fadeUp { from { opacity:0; transform: translateY(12px); } to { opacity:1; transform: translateY(0); } }

    .product-img {
      width: 100%;
      height: 140px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 3.5rem;
      background: var(--warm);
    }

    .product-info { padding: 1rem; }
    .product-name {
      font-family: 'Playfair Display', serif;
      font-size: 0.95rem;
      font-weight: 700;
      margin-bottom: 0.25rem;
      line-height: 1.3;
    }
    .product-id { font-size: 0.72rem; color: var(--muted); margin-bottom: 0.5rem; font-family: monospace; }
    .product-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
    .product-price { font-size: 1.1rem; font-weight: 700; color: var(--green); }
    .stock-badge {
      font-size: 0.72rem;
      padding: 0.2rem 0.5rem;
      border-radius: 20px;
      font-weight: 500;
    }
    .stock-ok  { background: #d4edda; color: #155724; }
    .stock-low { background: #fff3cd; color: #856404; }
    .stock-out { background: #f8d7da; color: #721c24; }

    .add-btn {
      width: 100%;
      padding: 0.55rem;
      border: 1.5px solid var(--green);
      background: transparent;
      color: var(--green);
      border-radius: 8px;
      font-family: 'DM Sans', sans-serif;
      font-weight: 500;
      font-size: 0.85rem;
      cursor: pointer;
      transition: all 0.15s;
    }
    .add-btn:hover { background: var(--green); color: #fff; }
    .add-btn:disabled { border-color: var(--border); color: var(--muted); cursor: not-allowed; }

    /* ── Loading ── */
    .loading {
      text-align: center;
      padding: 3rem;
      color: var(--muted);
      font-size: 0.95rem;
    }
    .spinner {
      width: 36px; height: 36px;
      border: 3px solid var(--border);
      border-top-color: var(--green);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 1rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Cart Drawer ── */
    .drawer-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.45);
      z-index: 200;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s;
    }
    .drawer-overlay.open { opacity: 1; pointer-events: auto; }

    .cart-drawer {
      position: fixed;
      top: 0; right: 0; bottom: 0;
      width: min(420px, 95vw);
      background: var(--cream);
      z-index: 300;
      display: flex; flex-direction: column;
      transform: translateX(100%);
      transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);
      box-shadow: -8px 0 32px rgba(0,0,0,0.15);
    }
    .cart-drawer.open { transform: translateX(0); }

    .drawer-header {
      background: var(--green);
      color: #fff;
      padding: 1.25rem 1.5rem;
      display: flex; align-items: center; justify-content: space-between;
    }
    .drawer-header h2 { font-family: 'Playfair Display', serif; font-size: 1.3rem; }
    .close-btn {
      background: none; border: none; color: #fff; font-size: 1.5rem;
      cursor: pointer; padding: 0.25rem; line-height: 1;
    }

    .cart-items { flex: 1; overflow-y: auto; padding: 1.25rem; display: flex; flex-direction: column; gap: 0.75rem; }
    .cart-empty { text-align: center; color: var(--muted); padding: 2rem; font-size: 0.9rem; }

    .cart-item {
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 0.85rem 1rem;
      display: flex; align-items: center; gap: 0.75rem;
    }
    .ci-emoji { font-size: 1.5rem; }
    .ci-info { flex: 1; }
    .ci-name { font-size: 0.85rem; font-weight: 500; margin-bottom: 0.15rem; }
    .ci-price { font-size: 0.8rem; color: var(--muted); }
    .ci-remove {
      background: none; border: none; color: var(--muted); cursor: pointer;
      font-size: 1.1rem; padding: 0.2rem; transition: color 0.15s;
    }
    .ci-remove:hover { color: var(--red); }

    .cart-footer {
      padding: 1.25rem 1.5rem;
      border-top: 1px solid var(--border);
      background: #fff;
    }
    .cart-total {
      display: flex; justify-content: space-between;
      font-weight: 700; font-size: 1.05rem; margin-bottom: 1rem;
    }
    .checkout-btn {
      width: 100%;
      padding: 0.85rem;
      background: var(--green);
      color: #fff;
      border: none;
      border-radius: 10px;
      font-family: 'DM Sans', sans-serif;
      font-weight: 600;
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.15s, transform 0.15s;
    }
    .checkout-btn:hover { background: var(--green2); transform: translateY(-1px); }
    .checkout-btn:disabled { background: var(--muted); cursor: not-allowed; transform: none; }

    /* ── Checkout Modal ── */
    .modal-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 400;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; pointer-events: none;
      transition: opacity 0.25s;
    }
    .modal-overlay.open { opacity: 1; pointer-events: auto; }

    .modal {
      background: var(--cream);
      border-radius: 20px;
      padding: 2rem;
      width: min(500px, 92vw);
      max-height: 90vh;
      overflow-y: auto;
      transform: scale(0.95);
      transition: transform 0.25s;
    }
    .modal-overlay.open .modal { transform: scale(1); }

    .modal h2 { font-family: 'Playfair Display', serif; font-size: 1.5rem; margin-bottom: 1.25rem; color: var(--green); }
    .modal-section { margin-bottom: 1.25rem; }
    .modal-section h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 0.75rem; }

    .order-line {
      display: flex; justify-content: space-between;
      font-size: 0.9rem; margin-bottom: 0.4rem;
    }
    .order-divider { border: none; border-top: 1px solid var(--border); margin: 0.75rem 0; }
    .order-total { font-weight: 700; font-size: 1rem; }

    .api-log {
      background: #1c1c1c;
      color: #a8ff78;
      border-radius: 10px;
      padding: 1rem;
      font-family: monospace;
      font-size: 0.75rem;
      line-height: 1.7;
      max-height: 220px;
      overflow-y: auto;
    }
    .api-log .log-pending { color: #ffd57e; }
    .api-log .log-success { color: #a8ff78; }
    .api-log .log-error   { color: #ff7e7e; }
    .api-log .log-info    { color: #7eb8ff; }

    .confirm-btn, .cancel-btn {
      padding: 0.75rem 1.5rem;
      border-radius: 10px;
      border: none;
      font-family: 'DM Sans', sans-serif;
      font-weight: 600;
      font-size: 0.9rem;
      cursor: pointer;
      transition: all 0.15s;
    }
    .confirm-btn { background: var(--green); color: #fff; }
    .confirm-btn:hover { background: var(--green2); }
    .cancel-btn { background: var(--border); color: var(--text); margin-right: 0.75rem; }
    .cancel-btn:hover { background: #d0c9c0; }
    .btn-row { display: flex; justify-content: flex-end; margin-top: 1.5rem; }

    .success-banner {
      text-align: center; padding: 1.5rem 0;
    }
    .success-banner .check { font-size: 3rem; margin-bottom: 0.5rem; }
    .success-banner h3 { font-family: 'Playfair Display', serif; font-size: 1.3rem; color: var(--green); }
    .success-banner p { color: var(--muted); font-size: 0.88rem; margin-top: 0.4rem; }

    /* ── Toast ── */
    #toast {
      position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%) translateY(80px);
      background: var(--text); color: #fff;
      padding: 0.65rem 1.25rem; border-radius: 24px;
      font-size: 0.85rem; font-weight: 500;
      z-index: 999; transition: transform 0.3s;
      white-space: nowrap;
    }
    #toast.show { transform: translateX(-50%) translateY(0); }

    /* ── API Monitor panel ── */
    .monitor-toggle {
      position: fixed; bottom: 1.5rem; right: 1.5rem;
      background: var(--green);
      color: #fff;
      border: none;
      border-radius: 50%;
      width: 48px; height: 48px;
      font-size: 1.2rem;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,0.25);
      z-index: 150;
      transition: transform 0.15s;
    }
    .monitor-toggle:hover { transform: scale(1.08); }

    .api-monitor {
      position: fixed; bottom: 5rem; right: 1.5rem;
      width: 360px;
      background: #1c1c1c;
      border-radius: 14px;
      z-index: 150;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      overflow: hidden;
      transform-origin: bottom right;
      transform: scale(0); opacity: 0;
      transition: transform 0.25s, opacity 0.25s;
    }
    .api-monitor.open { transform: scale(1); opacity: 1; }
    .monitor-header {
      background: #111; padding: 0.75rem 1rem;
      display: flex; align-items: center; justify-content: space-between;
      border-bottom: 1px solid #333;
    }
    .monitor-header span { color: #a8ff78; font-family: monospace; font-size: 0.8rem; font-weight: 700; }
    .monitor-clear { background: none; border: none; color: #666; font-size: 0.7rem; cursor: pointer; font-family: monospace; }
    .monitor-clear:hover { color: #aaa; }
    #monitor-log {
      color: #ccc;
      font-family: monospace;
      font-size: 0.72rem;
      line-height: 1.8;
      padding: 0.75rem 1rem;
      max-height: 300px;
      overflow-y: auto;
    }
    #monitor-log .m-ts { color: #555; }
    #monitor-log .m-method { color: #ffd57e; font-weight: 700; }
    #monitor-log .m-url { color: #7eb8ff; }
    #monitor-log .m-status-ok { color: #a8ff78; }
    #monitor-log .m-status-err { color: #ff7e7e; }
    #monitor-log .m-async { color: #c8a84b; }
  </style>
</head>
<body>

<!-- Header -->
<header>
  <div class="logo">
    <div class="logo-badge">A</div>
    <div class="logo-text">
      ABC Supermarkets
      <span>Powered by InventorySoft</span>
    </div>
  </div>
  <button class="cart-btn" onclick="openCart()">
    🛒 Cart <span class="cart-count" id="cart-count">0</span>
  </button>
</header>

<!-- Main -->
<main>
  <div class="org-tabs" id="org-tabs">
    <button class="org-tab active" onclick="loadOrg('351', this)">🛒 General Goods</button>
    <button class="org-tab" onclick="loadOrg('352', this)">🥐 Bakery</button>
    <button class="org-tab" onclick="loadOrg('353', this)">🥩 Deli</button>
  </div>

  <h2 class="section-heading" id="section-title">General Goods</h2>

  <div id="products" class="products-grid">
    <div class="loading">
      <div class="spinner"></div>
      Loading inventory from InventorySoft…
    </div>
  </div>
</main>

<!-- Cart Drawer -->
<div class="drawer-overlay" id="overlay" onclick="closeCart()"></div>
<div class="cart-drawer" id="cart-drawer">
  <div class="drawer-header">
    <h2>Your Cart</h2>
    <button class="close-btn" onclick="closeCart()">✕</button>
  </div>
  <div class="cart-items" id="cart-items">
    <div class="cart-empty">Your cart is empty.<br>Add some items to get started!</div>
  </div>
  <div class="cart-footer">
    <div class="cart-total">
      <span>Total</span>
      <span id="cart-total">$0.00</span>
    </div>
    <button class="checkout-btn" onclick="openCheckout()" id="checkout-btn" disabled>Proceed to Checkout</button>
  </div>
</div>

<!-- Checkout Modal -->
<div class="modal-overlay" id="checkout-modal">
  <div class="modal" id="modal-body">
    <!-- filled by JS -->
  </div>
</div>

<!-- Toast -->
<div id="toast"></div>

<!-- API Monitor -->
<button class="monitor-toggle" onclick="toggleMonitor()" title="API Monitor">⚡</button>
<div class="api-monitor" id="api-monitor">
  <div class="monitor-header">
    <span>⚡ InventorySoft API Monitor</span>
    <button class="monitor-clear" onclick="clearMonitor()">clear</button>
  </div>
  <div id="monitor-log"><span style="color:#555">// API calls will appear here...</span></div>
</div>

<script>
  const API_BASE = ''; // proxied through Node server
  let cart = [];
  let currentOrg = '351';

  // ── API Monitor ───────────────────────────────────────────────────────────
  let monitorOpen = false;
  function toggleMonitor() { monitorOpen = !monitorOpen; document.getElementById('api-monitor').classList.toggle('open', monitorOpen); }
  function clearMonitor() { document.getElementById('monitor-log').innerHTML = '<span style="color:#555">// cleared</span>'; }

  function logAPI(method, url, status, note) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    const statusClass = (!status || status >= 400) ? 'm-status-err' : 'm-status-ok';
    const statusStr = status ? \`<span class="\${statusClass}">\${status}</span>\` : '<span class="m-async">async→</span>';
    const el = document.getElementById('monitor-log');
    const line = document.createElement('div');
    line.innerHTML = \`<span class="m-ts">\${ts}</span> <span class="m-method">\${method}</span> <span class="m-url">\${url}</span> \${statusStr}\${note ? \` <span style="color:#888">\${note}</span>\` : ''}\`;
    if (el.firstChild && el.firstChild.textContent === '// API calls will appear here...') el.innerHTML = '';
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  // ── API Calls (via proxy) ─────────────────────────────────────────────────
  async function apiGet(path) {
    const r = await fetch(\`/proxy\${path}\`);
    logAPI('GET', path, r.status);
    return r.json();
  }

  async function apiPost(path, body) {
    const r = await fetch(\`/proxy\${path}\`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    logAPI('POST', path, r.status);
    return { status: r.status, data: await r.json() };
  }

  // ── Load Org ──────────────────────────────────────────────────────────────
  async function loadOrg(orgId, tabEl) {
    currentOrg = orgId;
    document.querySelectorAll('.org-tab').forEach(t => t.classList.remove('active'));
    tabEl.classList.add('active');

    const titles = { '351': 'General Goods', '352': 'Bakery', '353': 'Deli' };
    document.getElementById('section-title').textContent = titles[orgId];

    const grid = document.getElementById('products');
    grid.innerHTML = '<div class="loading"><div class="spinner"></div>Fetching inventory…</div>';

    try {
      const data = await apiGet(\`/organization/\${orgId}\`);
      renderProducts(data.items || []);
    } catch(e) {
      grid.innerHTML = \`<div class="loading" style="color:#c0392b">❌ Could not connect to InventorySoft API.<br><small>Make sure the mock server is running on port 3001.</small></div>\`;
    }
  }

  function renderProducts(items) {
    const grid = document.getElementById('products');
    if (!items.length) { grid.innerHTML = '<div class="loading">No items found.</div>'; return; }

    const emojis = {
      '92746661':'🥛','92746662':'🍞','92746663':'🥚','92746664':'🧀',
      '92746665':'🍗','92746666':'🍅','92746667':'🍊','92746668':'🥐',
      '92746669':'🦃','92746670':'💧'
    };

    grid.innerHTML = items.map((item, i) => {
      const emoji = emojis[item.itemId] || '🛒';
      const stock = item.stock;
      const [badgeClass, badgeText] = stock === 0 ? ['stock-out','Out of Stock'] : stock < 20 ? ['stock-low','Low Stock'] : ['stock-ok','In Stock'];
      const outOfStock = stock === 0;
      return \`
        <div class="product-card" style="animation-delay:\${i * 0.05}s">
          <div class="product-img">\${emoji}</div>
          <div class="product-info">
            <div class="product-name">\${item.name}</div>
            <div class="product-id">ID: \${item.itemId}</div>
            <div class="product-meta">
              <span class="product-price">$\${item.price.toFixed(2)}</span>
              <span class="stock-badge \${badgeClass}">\${stock > 0 ? stock + ' left' : badgeText}</span>
            </div>
            <button class="add-btn" \${outOfStock ? 'disabled' : ''} onclick="addToCart('\${item.itemId}', '\${item.name}', \${item.price}, '\${emoji}')">
              \${outOfStock ? 'Out of Stock' : 'Add to Cart'}
            </button>
          </div>
        </div>\`;
    }).join('');
  }

  // ── Cart ──────────────────────────────────────────────────────────────────
  function addToCart(id, name, price, emoji) {
    const existing = cart.find(c => c.id === id);
    if (existing) existing.qty++;
    else cart.push({ id, name, price, emoji, qty: 1, orgId: currentOrg });
    updateCartUI();
    toast(\`Added \${name} ✓\`);
  }

  function removeFromCart(id) {
    cart = cart.filter(c => c.id !== id);
    updateCartUI();
  }

  function updateCartUI() {
    const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
    const count = cart.reduce((s, c) => s + c.qty, 0);
    document.getElementById('cart-count').textContent = count;
    document.getElementById('cart-total').textContent = \`$\${total.toFixed(2)}\`;
    document.getElementById('checkout-btn').disabled = cart.length === 0;

    const el = document.getElementById('cart-items');
    if (!cart.length) { el.innerHTML = '<div class="cart-empty">Your cart is empty.</div>'; return; }
    el.innerHTML = cart.map(c => \`
      <div class="cart-item">
        <span class="ci-emoji">\${c.emoji}</span>
        <div class="ci-info">
          <div class="ci-name">\${c.name} × \${c.qty}</div>
          <div class="ci-price">$\${(c.price * c.qty).toFixed(2)}</div>
        </div>
        <button class="ci-remove" onclick="removeFromCart('\${c.id}')">✕</button>
      </div>\`).join('');
  }

  function openCart()  { document.getElementById('cart-drawer').classList.add('open'); document.getElementById('overlay').classList.add('open'); }
  function closeCart() { document.getElementById('cart-drawer').classList.remove('open'); document.getElementById('overlay').classList.remove('open'); }

  // ── Checkout ──────────────────────────────────────────────────────────────
  function openCheckout() {
    closeCart();
    const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
    const lines = cart.map(c => \`<div class="order-line"><span>\${c.emoji} \${c.name} × \${c.qty}</span><span>$\${(c.price * c.qty).toFixed(2)}</span></div>\`).join('');

    document.getElementById('modal-body').innerHTML = \`
      <h2>🧾 Review & Confirm Order</h2>
      <div class="modal-section">
        <h3>Order Summary</h3>
        \${lines}
        <hr class="order-divider"/>
        <div class="order-line order-total"><span>Total</span><span>$\${total.toFixed(2)}</span></div>
      </div>
      <div class="modal-section">
        <h3>What will happen</h3>
        <p style="font-size:0.85rem;color:var(--muted);line-height:1.6">
          Confirming will call <code style="background:#e8e2da;padding:2px 5px;border-radius:4px">POST /item/{id}</code> on the InventorySoft API for each line item (async sale registration). You can watch the calls in the ⚡ API Monitor.
        </p>
      </div>
      <div id="checkout-log" style="display:none" class="modal-section">
        <h3>API Call Log</h3>
        <div class="api-log" id="modal-api-log"></div>
      </div>
      <div class="btn-row" id="checkout-btns">
        <button class="cancel-btn" onclick="closeCheckout()">Cancel</button>
        <button class="confirm-btn" onclick="confirmCheckout()">Confirm Order</button>
      </div>\`;

    document.getElementById('checkout-modal').classList.add('open');
  }

  function closeCheckout() { document.getElementById('checkout-modal').classList.remove('open'); }

  async function confirmCheckout() {
    document.getElementById('checkout-btns').innerHTML = '<em style="color:var(--muted);font-size:0.85rem">Processing…</em>';
    document.getElementById('checkout-log').style.display = 'block';
    const logEl = document.getElementById('modal-api-log');

    const appendLog = (msg, cls) => {
      const line = document.createElement('div');
      line.className = cls || '';
      line.textContent = msg;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    };

    appendLog(\`[\${new Date().toISOString()}] Starting checkout for \${cart.length} line item(s)…\`, 'log-info');

    const salePromises = [];
    for (const item of cart) {
      for (let q = 0; q < item.qty; q++) {
        const path = \`/item/\${item.id}\`;
        const body = { itemId: item.id, organizationId: item.orgId };
        appendLog(\`→ POST /item/\${item.id}  (qty unit \${q+1}/\${item.qty})\`, 'log-pending');
        salePromises.push(
          apiPost(path, body).then(({ status, data }) => {
            if (data.eventId) {
              appendLog(\`  ✓ eventId: \${data.eventId}\`, 'log-success');
              pollEvent(data.eventId, item.id, appendLog);
            } else {
              appendLog(\`  ✗ Error: \${JSON.stringify(data)}\`, 'log-error');
            }
          }).catch(() => appendLog(\`  ✗ Network error\`, 'log-error'))
        );
        // stagger slightly to be friendly to rate limits
        await new Promise(r => setTimeout(r, 60));
      }
    }

    await Promise.all(salePromises);

    setTimeout(() => {
      document.getElementById('checkout-log').style.display = 'none';
      document.getElementById('modal-body').innerHTML = \`
        <div class="success-banner">
          <div class="check">🎉</div>
          <h3>Order Confirmed!</h3>
          <p>All sale events have been registered with InventorySoft.<br>Inventory will update within moments.</p>
        </div>
        <div class="btn-row">
          <button class="confirm-btn" onclick="finishCheckout()">Back to Shopping</button>
        </div>\`;
    }, 800);
  }

  async function pollEvent(eventId, itemId, appendLog) {
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 400));
      try {
        const r = await fetch(\`/proxy/events/\${eventId}\`);
        const d = await r.json();
        logAPI('GET', \`/events/\${eventId}\`, r.status, d.status);
        if (d.status === 'COMPLETED') {
          appendLog(\`  ⚡ event \${eventId.slice(0,8)}… COMPLETED\`, 'log-success');
          return;
        }
      } catch {}
    }
    appendLog(\`  ⏳ event \${eventId.slice(0,8)}… still pending\`, 'log-pending');
  }

  function finishCheckout() {
    cart = [];
    updateCartUI();
    closeCheckout();
    loadOrg(currentOrg, document.querySelector('.org-tab.active'));
    toast('Order complete! Inventory refreshed.');
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  let toastTimer;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  loadOrg('351', document.querySelector('.org-tab'));
</script>
</body>
</html>`;

// ─── Node Server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Proxy requests to InventorySoft mock API
  if (req.url.startsWith("/proxy/")) {
    const targetPath = req.url.replace("/proxy", "");
    const targetUrl = `${INVENTORYSOFT_BASE}${targetPath}`;

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const fetchOptions = {
          method: req.method,
          headers: { "Content-Type": "application/json" },
        };
        if (req.method === "POST" && body) fetchOptions.body = body;

        // Use built-in fetch (Node 18+) or http module
        const upstream = await makeRequest(targetUrl, fetchOptions);
        res.writeHead(upstream.status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(upstream.body);
      } catch (e) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Could not reach InventorySoft API. Is it running on port 3001?" }));
      }
    });
    return;
  }

  // Serve the HTML app
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(HTML);
});

// Simple HTTP request helper (no external deps)
function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? require("https") : require("http");
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };
    const r = mod.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    r.on("error", reject);
    if (options.body) r.write(options.body);
    r.end();
  });
}

server.listen(PORT, () => {
  console.log(`\n✅  ABC Supermarkets app running at http://localhost:${PORT}`);
  console.log(`   Proxying InventorySoft API → ${INVENTORYSOFT_BASE}`);
  console.log("   (Set INVENTORYSOFT_URL env var to change the target)\n");
});
