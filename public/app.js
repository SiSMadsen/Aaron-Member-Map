/* global L */
(() => {
  const $ = (id) => document.getElementById(id);

  const ERRORS = {
    not_member: "You're not a member of the Discord server, so you can't add yourself to the map.",
    missing_role: "You don't have the role needed to add yourself to the map.",
    state: 'Login expired or was tampered with. Please try again.',
    cancelled: 'Discord login was cancelled.',
    discord: 'Something went wrong talking to Discord. Please try again.',
  };

  const state = {
    config: null,
    user: null,
    pin: null,
    countries: [],
    countryByName: new Map(),
    countryByCode: new Map(),
    provinces: null, // GeoJSON of the country being picked
    selectedCountry: null,
    selectedProvinceId: null,
  };

  // -------------------------------------------------------------------------
  // Helpers

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) node.append(child);
    return node;
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status });
    return body;
  }

  const FALLBACK_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';

  // Discord avatar at a given size. Falls back to the default avatar if the stored one is
  // gone (the member changed it since they last logged in).
  function avatar(url, size, alt = '') {
    const img = el('img', { src: `${url}?size=${size}`, alt, loading: 'lazy' });
    img.addEventListener('error', () => {
      if (!img.src.startsWith(FALLBACK_AVATAR)) img.src = FALLBACK_AVATAR;
    });
    return img;
  }

  function showBanner(message) {
    const banner = $('banner');
    banner.textContent = message;
    banner.hidden = !message;
  }

  function setStatus(message, kind = '') {
    const status = $('status');
    status.textContent = message;
    status.className = `status ${kind}`;
  }

  // -------------------------------------------------------------------------
  // Map

  const map = L.map('map', { worldCopyJump: true, minZoom: 2, maxZoom: 18 }).setView([30, 10], 2);

  const pinLayer = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 45,
    spiderfyDistanceMultiplier: 1.6,
    iconCreateFunction(cluster) {
      const markers = cluster.getAllChildMarkers().slice(0, 3);
      const stack = el('div', { class: 'stack' });
      markers.forEach((marker, i) => {
        const img = avatar(marker.options.pin.avatarUrl, 64);
        img.style.left = `${i * 10}px`;
        img.style.top = `${i * 4}px`;
        stack.append(img);
      });
      stack.append(el('span', { class: 'badge', text: String(cluster.getChildCount()) }));
      return L.divIcon({ html: stack, className: 'avatar-cluster', iconSize: [58, 46] });
    },
  });
  map.addLayer(pinLayer);

  let provinceLayer = null;

  // Leaflet ignores a new view requested while a zoom animation is still running (e.g. picking
  // a province right after the map zoomed to the country), so wait for it to finish.
  function whenIdle(fn) {
    if (map._animatingZoom) map.once('zoomend', fn);
    else fn();
  }

  function memberCard(pin) {
    return el('div', { class: 'member-card' }, [
      avatar(pin.avatarUrl, 128),
      el('div', {}, [
        el('div', { class: 'display', text: pin.displayName }),
        el('div', { class: 'handle', text: `@${pin.username}` }),
        el('div', { class: 'place', text: `${pin.provinceName}, ${pin.countryName}` }),
      ]),
    ]);
  }

  function renderPins(pins) {
    pinLayer.clearLayers();
    for (const pin of pins) {
      const isMe = state.user && pin.id === state.user.id;
      const icon = L.divIcon({
        html: avatar(pin.avatarUrl, 64),
        className: `avatar-marker${isMe ? ' me' : ''}`,
        iconSize: [40, 40],
        popupAnchor: [0, -18],
      });
      const marker = L.marker([pin.lat, pin.lon], { icon, pin, title: pin.displayName });
      marker.bindPopup(() => memberCard(pin));
      pinLayer.addLayer(marker);
    }
    const countries = new Set(pins.map((p) => p.countryCode)).size;
    $('count').textContent = pins.length
      ? `${pins.length} ${pins.length === 1 ? 'member' : 'members'} · ${countries} ${countries === 1 ? 'country' : 'countries'}`
      : 'No one here yet';
  }

  async function loadPins() {
    try {
      const { pins } = await api('/api/pins');
      renderPins(pins);
      $('gate').hidden = true;
    } catch (err) {
      if (err.status === 401) $('gate').hidden = false;
      else showBanner(`Couldn't load the map: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Account

  function renderAccount() {
    const account = $('account');
    account.replaceChildren();
    if (!state.user) {
      account.append(el('a', { class: 'button discord', href: '/auth/login', text: 'Log in with Discord' }));
      $('panel').hidden = true;
      return;
    }
    const logout = el('button', { class: 'button link', type: 'button', text: 'Log out' });
    logout.addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
      location.reload();
    });
    account.append(
      avatar(state.user.avatarUrl, 64),
      el('span', { class: 'name', text: state.user.displayName }),
      logout,
    );
    $('panel').hidden = false;
    renderCurrent();
  }

  function renderCurrent() {
    const { pin } = state;
    $('current').textContent = pin
      ? `You're on the map in ${pin.provinceName}, ${pin.countryName}. Pick another place to move.`
      : "You're not on the map yet. Pick your country and province.";
    $('remove').hidden = !pin;
  }

  // -------------------------------------------------------------------------
  // Picking a province

  const STYLE = {
    normal: { color: '#5865f2', weight: 1, fillColor: '#5865f2', fillOpacity: 0.08 },
    hover: { weight: 2, fillOpacity: 0.25 },
    selected: { color: '#3c45a5', weight: 3, fillColor: '#5865f2', fillOpacity: 0.45 },
  };

  function styleFor(feature) {
    return feature.properties.id === state.selectedProvinceId ? STYLE.selected : STYLE.normal;
  }

  function selectProvince(id, { zoom = false } = {}) {
    state.selectedProvinceId = id || null;
    $('province').value = id || '';
    $('save').disabled = !id;
    if (!provinceLayer) return;
    provinceLayer.setStyle(styleFor);
    if (id && zoom) {
      provinceLayer.eachLayer((layer) => {
        if (layer.feature.properties.id !== id) return;
        whenIdle(() => map.fitBounds(layer.getBounds(), { maxZoom: 7, padding: [40, 40] }));
      });
    }
  }

  async function selectCountry(country, provinceId = null) {
    state.selectedCountry = country;
    state.selectedProvinceId = null;
    const select = $('province');
    select.replaceChildren(el('option', { value: '', text: country ? 'Loading…' : 'Pick a country first' }));
    select.disabled = true;
    $('save').disabled = true;
    if (provinceLayer) {
      map.removeLayer(provinceLayer);
      provinceLayer = null;
    }
    if (!country) return;

    const [w, s, e, n] = country.bbox;
    whenIdle(() => map.fitBounds([[s, w], [n, e]], { padding: [20, 20] }));

    const res = await fetch(`/data/provinces/${country.code}.json`);
    const geojson = await res.json();
    if (state.selectedCountry !== country) return; // the user picked something else meanwhile
    state.provinces = geojson;

    select.replaceChildren(el('option', { value: '', text: 'Choose…' }));
    for (const f of geojson.features) {
      const label = f.properties.type ? `${f.properties.name} (${f.properties.type})` : f.properties.name;
      select.append(el('option', { value: f.properties.id, text: label }));
    }
    select.disabled = false;

    provinceLayer = L.geoJSON(geojson, {
      style: styleFor,
      onEachFeature(feature, layer) {
        layer.bindTooltip(feature.properties.name, { sticky: true });
        layer.on({
          click: () => selectProvince(feature.properties.id),
          mouseover: () => feature.properties.id !== state.selectedProvinceId && layer.setStyle(STYLE.hover),
          mouseout: () => layer.setStyle(styleFor(feature)),
        });
      },
    }).addTo(map);

    selectProvince(provinceId);
  }

  async function loadCountries() {
    state.countries = await (await fetch('/data/countries.json')).json();
    const list = $('country-list');
    for (const c of state.countries) {
      state.countryByName.set(c.name.toLowerCase(), c);
      state.countryByCode.set(c.code, c);
      list.append(el('option', { value: c.name }));
    }
  }

  function onCountryInput() {
    const country = state.countryByName.get($('country').value.trim().toLowerCase()) || null;
    if (country !== state.selectedCountry) selectCountry(country);
  }

  async function save() {
    if (!state.selectedCountry || !state.selectedProvinceId) return;
    $('save').disabled = true;
    setStatus('Saving…');
    try {
      const { pin } = await api('/api/pin', {
        method: 'PUT',
        body: JSON.stringify({ countryCode: state.selectedCountry.code, provinceId: state.selectedProvinceId }),
      });
      state.pin = pin;
      renderCurrent();
      setStatus('Saved! You are on the map.', 'ok');
      await loadPins();
      whenIdle(() => map.setView([pin.lat, pin.lon], Math.max(map.getZoom(), 5)));
    } catch (err) {
      setStatus(err.message, 'error');
    } finally {
      $('save').disabled = !state.selectedProvinceId;
    }
  }

  async function remove() {
    if (!confirm('Remove yourself from the map?')) return;
    try {
      await api('/api/pin', { method: 'DELETE', body: '{}' });
      state.pin = null;
      renderCurrent();
      setStatus('You have been removed from the map.', 'ok');
      await loadPins();
    } catch (err) {
      setStatus(err.message, 'error');
    }
  }

  // -------------------------------------------------------------------------
  // Start

  async function init() {
    const params = new URLSearchParams(location.search);
    if (params.has('error')) {
      showBanner(ERRORS[params.get('error')] || 'Login failed.');
      history.replaceState(null, '', location.pathname);
    }

    const [config, me] = await Promise.all([api('/api/config'), api('/api/me'), loadCountries()]);
    state.config = config;
    state.user = me.user;
    state.pin = me.pin;

    document.title = config.title;
    $('title').textContent = config.title;
    L.tileLayer(config.tileUrl, { attribution: config.tileAttribution, maxZoom: 18 }).addTo(map);

    renderAccount();
    await loadPins();

    $('country').addEventListener('input', onCountryInput);
    $('country').addEventListener('change', onCountryInput);
    $('province').addEventListener('change', (e) => selectProvince(e.target.value, { zoom: true }));
    $('save').addEventListener('click', save);
    $('remove').addEventListener('click', remove);
    $('collapse').addEventListener('click', () => {
      const collapsed = $('panel').classList.toggle('collapsed');
      $('collapse').textContent = collapsed ? '+' : '–';
      $('collapse').setAttribute('aria-expanded', String(!collapsed));
    });

    if (state.pin) {
      const country = state.countryByCode.get(state.pin.countryCode);
      if (country) {
        $('country').value = country.name;
        await selectCountry(country, state.pin.provinceId);
        whenIdle(() => map.setView([state.pin.lat, state.pin.lon], 5));
      }
    }
  }

  init().catch((err) => showBanner(`Something went wrong: ${err.message}`));
})();
