const API_URL = 'https://graphql.anilist.co';
const SUPABASE_URL = 'https://pebpxvymmoqlezsqewyt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_OEMXXgntsFTGS-N-Ve9ZCg_QAf8GM2W';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let myAnimeList = [];
let currentSelectedAnime = null;
let searchTimeout = null;
let nextEpisodeCache = {};
let searchRequestId = 0; // usado para ignorar respostas de buscas antigas/obsoletas
let focusedCardIndex = -1; // índice do card atualmente destacado via teclado

const aniListLimiter = {
    queue: [],
    processing: false,
    minGapMs: 2000, // AniList está em modo degradado: 30 req/min = 1 a cada 2 segundos

    schedule(job) {
        return new Promise((resolve, reject) => {
            this.queue.push({ job, resolve, reject });
            this._run();
        });
    },

    async _run() {
        if (this.processing) return;
        this.processing = true;
        while (this.queue.length) {
            const { job, resolve, reject } = this.queue.shift();
            try {
                resolve(await job());
            } catch (e) {
                reject(e);
            }
            await new Promise(r => setTimeout(r, this.minGapMs));
        }
        this.processing = false;
    }
};

async function performAniListRequest(query, variables, retriesLeft = 3, attempt = 0) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query, variables }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.status === 429) {
            if (retriesLeft <= 0) throw new Error('Limite da AniList excedido. Tente novamente em breve.');
            // Tenta ler o header Retry-After. Se o navegador bloquear via CORS (comum), cai no backoff exponencial.
            const headerRetry = parseInt(response.headers.get('Retry-After') || '', 10);
            const backoffMs = !isNaN(headerRetry) ? headerRetry * 1000 : Math.min(3000 * Math.pow(2, attempt), 30000);
            await new Promise(r => setTimeout(r, backoffMs + 300));
            return performAniListRequest(query, variables, retriesLeft - 1, attempt + 1);
        }

        if (response.status === 404) {
            const err = new Error('Anime não encontrado na AniList.');
            err.code = 'NOT_FOUND';
            throw err;
        }

        if (response.status >= 500 && retriesLeft > 0) {
            await new Promise(r => setTimeout(r, 1200));
            return performAniListRequest(query, variables, retriesLeft - 1, attempt + 1);
        }

        if (!response.ok) throw new Error(`Erro na AniList: ${response.status}`);

        const json = await response.json();
        if (json.errors) throw new Error(json.errors[0]?.message || 'Erro desconhecido na AniList');
        return json.data;
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('A busca demorou demais para responder. Tente novamente.');
        throw e;
    }
}

async function queryAniList(query, variables = {}) {
    return aniListLimiter.schedule(() => performAniListRequest(query, variables));
}

function getBestTitle(titleObj, synonyms = []) {
    if (titleObj?.english) return titleObj.english;
    if (Array.isArray(synonyms) && synonyms.length > 0 && synonyms[0]) return synonyms[0];
    if (titleObj?.romaji) return titleObj.romaji;
    return 'Título Indisponível';
}

function getBestYear(media) {
    return media?.seasonYear || media?.startDate?.year || null;
}

function cleanDescription(desc) {
    return desc ? desc.replace(/<[^>]*>?/gm, '') : null;
}

function splitTextForTranslation(text, maxLen = 1500) {
    if (text.length <= maxLen) return [text];
    const sentences = text.match(/[^.!?]+[.!?]+|\S+$/g) || [text];
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
        if ((current + sentence).length > maxLen) {
            if (current) chunks.push(current);
            current = sentence;
        } else {
            current += sentence;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

async function translateToPtBr(text) {
    if (!text) return { text, success: false };
    try {
        const chunks = splitTextForTranslation(text);
        const translatedParts = [];
        for (const chunk of chunks) {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t&q=${encodeURIComponent(chunk)}`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`Tradução falhou: ${resp.status}`);
            const data = await resp.json();
            const translated = data[0].map(part => part[0]).join('');
            translatedParts.push(translated);
        }
        return { text: translatedParts.join(' '), success: true };
    } catch (e) {
        console.warn('Falha ao traduzir, mantendo texto original em inglês:', e.message);
        UI.showToast(`[DEBUG] Erro tradução: ${e.message}`, 'error', 5000);
        return { text, success: false };
    }
}

// ---------- DADOS DINÂMICOS (próximo episódio + auto-preenchimento) ----------

function formatAiringCountdown(airingAtUnix) {
    const diffMs = (airingAtUnix * 1000) - Date.now();
    const diffSeconds = Math.floor(diffMs / 1000);
    if (diffSeconds <= 0) return 'a qualquer momento';
    const days = Math.floor(diffSeconds / 86400);
    const hours = Math.floor((diffSeconds % 86400) / 3600);
    if (days > 0) return `em ${days}d ${hours}h`;
    const minutes = Math.floor((diffSeconds % 3600) / 60);
    if (hours > 0) return `em ${hours}h ${minutes}min`;
    return `em ${minutes}min`;
}

async function refreshLiveAniListData() {
    const candidates = myAnimeList.filter(a =>
        (a.status === 'watching' || a.status === 'planned') &&
        !isNaN(parseInt(a.mal_id))
    );
    if (candidates.length === 0) return;

    const uniqueIds = [...new Set(candidates.map(a => parseInt(a.mal_id)))];
    const chunkSize = 50; // limite do Page da AniList
    const chunks = [];
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
        chunks.push(uniqueIds.slice(i, i + chunkSize));
    }

    const gqlQuery = `
        query ($ids: [Int]) {
            Page(perPage: 50) {
                media(id_in: $ids, type: ANIME) {
                    id
                    episodes
                    seasonYear
                    startDate { year }
                    nextAiringEpisode { airingAt episode }
                }
            }
        }
    `;

    nextEpisodeCache = {};
    for (const chunk of chunks) {
        try {
            const data = await queryAniList(gqlQuery, { ids: chunk });
            const mediaList = data?.Page?.media || [];
            for (const m of mediaList) {
                if (m.nextAiringEpisode) {
                    nextEpisodeCache[m.id] = m.nextAiringEpisode;
                }
                // Só grava no banco o que estiver faltando — nunca sobrescreve dados já existentes
                const matches = candidates.filter(a => parseInt(a.mal_id) === m.id);
                for (const dbAnime of matches) {
                    const fields = {};
                    if ((!dbAnime.total_ep || dbAnime.total_ep === 0) && m.episodes) {
                        fields.total_ep = m.episodes;
                    }
                    if (!dbAnime.year) {
                        const bestYear = getBestYear(m);
                        if (bestYear) fields.year = bestYear;
                    }
                    if (Object.keys(fields).length > 0) {
                        await updateAnimeFields(dbAnime.id, fields);
                        Object.assign(dbAnime, fields);
                    }
                }
            }
        } catch (e) {
            console.warn('Falha ao atualizar dados dinâmicos da AniList:', e.message);
        }
    }
}

const authContainer = document.getElementById('auth-container');
const loginForm = document.getElementById('login-form');
const authEmail = document.getElementById('auth-email');
const authPassword = document.getElementById('auth-password');
const authSubmit = document.getElementById('auth-submit');
const authError = document.getElementById('auth-error');
const searchInput = document.getElementById('anime-search');
const searchBtn = document.getElementById('search-btn');
const clearBtn = document.getElementById('clear-search');
const animeGrid = document.getElementById('anime-grid');
const animeDetail = document.getElementById('anime-detail');
const filterBtns = document.querySelectorAll('.filter-btn');
const sortSelect = document.getElementById('sort-select');
const genreSelect = document.getElementById('genre-select');
const modal = document.getElementById('custom-modal');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalFooter = document.getElementById('modal-footer');
const closeModal = document.getElementById('modal-close-x');
const searchResults = document.getElementById('search-results');
const toastContainer = document.getElementById('toast-container');
const mainContent = document.getElementById('main-content');

function toggleAuthUI(isLoggedIn) {
    authContainer.style.display = isLoggedIn ? 'none' : 'flex';
}

async function checkUserSession() {
    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error || !session) {
        toggleAuthUI(false);
        return false;
    }
    toggleAuthUI(true);
    return true;
}

async function handleLogin(e) {
    e.preventDefault();
    authError.innerText = '';
    authSubmit.innerText = 'Autenticando...';
    authSubmit.disabled = true;
    const email = authEmail.value.trim();
    const password = authPassword.value.trim();
    try {
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        toggleAuthUI(true);
        await initApp();
    } catch (err) {
        authError.innerText = err.message || 'Falha na autenticação.';
    } finally {
        authSubmit.innerText = 'Entrar no Sistema';
        authSubmit.disabled = false;
    }
}

const UI = {
    showModal(title, contentHTML, buttons = []) {
        modalTitle.innerText = title;
        modalBody.innerHTML = contentHTML;
        modalFooter.innerHTML = '';
        buttons.forEach(btn => {
            const button = document.createElement('button');
            button.className = `btn-modal ${btn.class}`;
            button.innerText = btn.text;
            button.onclick = btn.action;
            modalFooter.appendChild(button);
        });
        modal.style.display = 'flex';
    },
    hideModal() {
        modal.style.display = 'none';
    },
    showToast(message, type = 'success', duration = 3000) {
        const icons = { success: '✅', error: '❌', info: 'ℹ️' };
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;
        toastContainer.appendChild(toast);

        requestAnimationFrame(() => toast.classList.add('show'));

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 350);
        }, duration);
    }
};

async function loadList() {
    const { data, error } = await supabaseClient
        .from('animes')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) { console.error('Erro ao carregar lista:', error); return; }
    myAnimeList = data;
    updateGenreDropdown();
}

async function addAnimeToDB(anime) {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) { console.error('Usuário não autenticado.'); return { success: false, reason: 'auth' }; }

    const { error } = await supabaseClient.from('animes').insert([{
        mal_id: anime.mal_id,
        title: anime.title,
        title_english: anime.title_english || null,
        title_romaji: anime.title_romaji || null,
        status: anime.status,
        current_ep: anime.current_ep || 0,
        total_ep: anime.total_ep || 0,
        cover_url: anime.cover_url,
        year: anime.year,
        genres: anime.genres || [],
        synopsis: anime.synopsis || null,
        synopsis_lang: anime.synopsis_lang || 'pt',
        user_id: user.id
    }]);

    if (error) {
        if (error.code === '23505') {
            console.warn('Inserção bloqueada: anime já existe na lista.', anime.title);
            return { success: false, reason: 'duplicate' };
        }
        console.error('Erro ao adicionar anime:', error);
        return { success: false, reason: 'unknown' };
    }
    return { success: true };
}

async function updateAnimeFields(id, fields) {
    const { error } = await supabaseClient.from('animes').update(fields).eq('id', id);
    if (error) console.error('Erro ao atualizar anime:', error);
}

async function removeAnime(id_db) {
    await supabaseClient.from('animes').delete().eq('id', id_db);
}

// ---------- BUSCA DE NOVOS ANIMES (AniList) ----------

function getStatusLabel(status) {
    return status === 'watching' ? '🔵 Assistindo'
        : status === 'completed' ? '✅ Concluído'
        : '⏳ Planejado';
}

function findExistingAnime(anilistId) {
    return myAnimeList.find(a => parseInt(a.mal_id) === parseInt(anilistId));
}

function showDuplicateWarning(existingAnime) {
    UI.showModal('Anime já na sua lista', `
        <p>O anime <strong>${existingAnime.title}</strong> já está cadastrado como:</p>
        <p style="margin-top:12px;font-size:1.1rem;text-align:center;">${getStatusLabel(existingAnime.status)}</p>
    `, [
        {
            text: 'Ver Anime',
            class: 'btn-confirm',
            action: () => {
                UI.hideModal();
                filterBtns.forEach(b => b.classList.toggle('active', b.dataset.filter === existingAnime.status));
                showDetail(existingAnime.id);
            }
        },
        { text: 'Fechar', class: 'btn-cancel', action: UI.hideModal }
    ]);
}

const SEARCH_CACHE_PREFIX = 'anilist_search_';
const SEARCH_CACHE_TTL = 10 * 60 * 1000; // 10 minutos

function normalizeSearchQuery(q) {
    return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getSearchCache(query) {
    try {
        const raw = localStorage.getItem(SEARCH_CACHE_PREFIX + query);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.timestamp > SEARCH_CACHE_TTL) {
            localStorage.removeItem(SEARCH_CACHE_PREFIX + query);
            return null;
        }
        return parsed.data;
    } catch (e) {
        return null;
    }
}

function setSearchCache(query, data) {
    try {
        localStorage.setItem(SEARCH_CACHE_PREFIX + query, JSON.stringify({ data, timestamp: Date.now() }));
    } catch (e) {
        // localStorage cheio ou indisponível — ignora silenciosamente, não é crítico
    }
}

function cleanupSearchCache() {
    try {
        const now = Date.now();
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(SEARCH_CACHE_PREFIX)) {
                try {
                    const parsed = JSON.parse(localStorage.getItem(key));
                    if (!parsed || (now - parsed.timestamp > SEARCH_CACHE_TTL)) {
                        keysToRemove.push(key);
                    }
                } catch (e) {
                    keysToRemove.push(key); // entrada corrompida
                }
            }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch (e) {
        // localStorage indisponível — ignora
    }
}

function showSearchLoading() {
    searchResults.innerHTML = `<div class="search-loading"><span class="mini-spinner"></span> Buscando...</div>`;
    searchResults.style.display = 'block';
}

function renderSearchOutcome(animes) {
    if (animes.length > 0) {
        renderSuggestions(animes);
    } else {
        searchResults.innerHTML = '<div style="padding:15px;color:var(--text-dim);">Nenhum resultado encontrado.</div>';
        searchResults.style.display = 'block';
    }
}

async function fetchSuggestions() {
    const query = searchInput.value.trim();
    if (query.length < 3) { searchResults.style.display = 'none'; return; }

    const normalizedQuery = normalizeSearchQuery(query);
    const requestId = ++searchRequestId;

    // 1. Cache hit -> resposta instantânea, sem chamar a AniList
    const cached = getSearchCache(normalizedQuery);
    if (cached) {
        renderSearchOutcome(cached);
        return;
    }

    showSearchLoading();

    const gqlQuery = `
        query ($search: String) {
            Page(perPage: 15) {
                media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
                    id
                    title { english romaji }
                    synonyms
                    coverImage { large }
                    seasonYear
                    startDate { year }
                    episodes
                    genres
                    description
                }
            }
        }
    `;
    
    try {
        const data = await queryAniList(gqlQuery, { search: query });
        if (requestId !== searchRequestId) return; // busca mais nova já foi disparada, ignora esta resposta

        const animes = data?.Page?.media || [];
        setSearchCache(normalizedQuery, animes);
        renderSearchOutcome(animes);
    } catch (e) {
        if (requestId !== searchRequestId) return;
        console.warn('Busca falhou:', e.message);
        searchResults.innerHTML = `<div style="padding:15px;color:var(--text-dim);">${e.message}</div>`;
        searchResults.style.display = 'block';
    }
}

function renderSuggestions(animes) {
    searchResults.innerHTML = '';
    searchResults.style.display = 'block';
    animes.forEach(anime => {
        const title = getBestTitle(anime.title, anime.synonyms);
        const imgUrl = anime.coverImage?.large || 'https://via.placeholder.com/40x60?text=No+Img';
        const item = document.createElement('div');
        item.className = 'result-item';
        item.innerHTML = `<img src="${imgUrl}" alt="${title}"><span class="title">${title}</span>`;
        item.onclick = () => {
            searchResults.style.display = 'none';
            const existing = findExistingAnime(anime.id);
            if (existing) {
                showDuplicateWarning(existing);
            } else {
                currentSelectedAnime = anime;
                showStatusPicker();
            }
        };
        searchResults.appendChild(item);
    });
}

function showStatusPicker() {
    const anime = currentSelectedAnime;
    UI.showModal('Definir Status', `
        <p style="margin-bottom:15px;">Em qual categoria deseja adicionar <strong>${getBestTitle(anime.title, anime.synonyms)}</strong>?</p>
        <div style="display:grid;gap:10px;">
            <button class="btn-modal btn-cancel status-opt" data-status="watching">🔵 Assistindo</button>
            <button class="btn-modal btn-cancel status-opt" data-status="completed">✅ Concluído</button>
            <button class="btn-modal btn-cancel status-opt" data-status="planned">⏳ Planejado</button>
        </div>
    `, []);
    document.querySelectorAll('.status-opt').forEach(btn => {
        btn.onclick = () => { finalizeAdd(btn.dataset.status); };
    });
}

async function finalizeAdd(status) {
    const anime = currentSelectedAnime;
    const totalEp = anime.episodes || 0;
    const rawSynopsis = cleanDescription(anime.description);
    const translationResult = await translateToPtBr(rawSynopsis);

    const newAnime = {
        mal_id: anime.id,
        title: getBestTitle(anime.title, anime.synonyms),
        title_english: anime.title?.english || (anime.synonyms?.[0] || null),
        title_romaji: anime.title?.romaji || null,
        cover_url: anime.coverImage?.large,
        year: getBestYear(anime),
        total_ep: totalEp,
        status: status,
        current_ep: status === 'completed' ? totalEp : 0,
        synopsis: translationResult.text,
        synopsis_lang: translationResult.success ? 'pt' : 'en',
        genres: anime.genres || [],
    };

    const result = await addAnimeToDB(newAnime);

    if (!result.success) {
        UI.hideModal();
        if (result.reason === 'duplicate') {
            await loadList();
            const existing = findExistingAnime(anime.id);
            if (existing) showDuplicateWarning(existing);
        } else {
            UI.showModal('Erro', 'Não foi possível adicionar o anime. Tente novamente.', [
                { text: 'Ok', class: 'btn-confirm', action: UI.hideModal }
            ]);
        }
        return;
    }

    await loadList();
    searchInput.value = '';
    clearBtn.style.display = 'none';
    UI.hideModal();
    renderGrid(document.querySelector('.filter-btn.active').dataset.filter, '');
    UI.showToast(`"${newAnime.title}" adicionado com sucesso!`, 'success');
}

// ---------- GRID PRINCIPAL ----------

function renderGrid(filter, query = '') {
    focusedCardIndex = -1; // grid foi refeito, qualquer navegação anterior perde sentido
    let list = myAnimeList.filter(a => a.status === filter);

    if (query) {
        const q = query.toLowerCase();
        list = list.filter(a =>
            a.title.toLowerCase().includes(q) ||
            (a.title_english && a.title_english.toLowerCase().includes(q)) ||
            (a.title_romaji && a.title_romaji.toLowerCase().includes(q))
        );
    }

    const genreVal = genreSelect.value;
    if (genreVal && genreVal !== 'all') {
        list = list.filter(a => a.genres && a.genres.includes(genreVal));
    }

    const sortVal = sortSelect.value;
    if (sortVal === 'alpha') {
        list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    } else {
        list = [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    animeGrid.innerHTML = '';

    if (list.length === 0) {
        animeGrid.innerHTML = `<p style="color:var(--text-dim);grid-column:1/-1;text-align:center;padding:40px 0;">Nenhum anime encontrado.</p>`;
        return;
    }

    list.forEach(anime => {
        const badgeClass = anime.status === 'watching' ? 'badge-watching'
            : anime.status === 'completed' ? 'badge-completed' : 'badge-planned';
        const badgeLabel = anime.status === 'watching' ? 'Assistindo'
            : anime.status === 'completed' ? 'Concluído' : 'Planejado';

        let metaRight;
        if (anime.status === 'watching') {
            metaRight = `<span class="current-ep">Ep ${anime.current_ep || 0}/${anime.total_ep || '?'}</span>`;
        } else if (anime.status === 'completed') {
            metaRight = `<span class="ep-completed">${anime.total_ep || '?'} Episódios</span>`;
        } else {
            metaRight = `<span class="ep-planned">${anime.total_ep || '?'} Episódios</span>`;
        }

                const nextEp = nextEpisodeCache[parseInt(anime.mal_id)];
        const nextEpHTML = nextEp
            ? `<div class="next-ep-info">🕐 Ep ${nextEp.episode} ${formatAiringCountdown(nextEp.airingAt)}</div>`
            : '';

        const card = document.createElement('div');
        card.className = 'anime-card';
        card.innerHTML = `
            <span class="status-badge ${badgeClass}">${badgeLabel}</span>
            <button class="delete-btn" title="Remover">&times;</button>
            <img src="${anime.cover_url || ''}" alt="${anime.title}" loading="lazy">
            <div class="card-info">
                <h3>${anime.title}</h3>
                <div class="card-meta">
                    <span class="meta-year">${anime.year || 'N/A'}</span>
                    ${metaRight}
                </div>
                ${nextEpHTML}
            </div>
        `;
        
        card.querySelector('.delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteAnime(anime.id);
        });
        card.addEventListener('click', () => showDetail(anime.id));
        animeGrid.appendChild(card);
    });
}

// ---------- TELA DE DETALHES ----------

async function showDetail(id_db) {
    const anime = myAnimeList.find(a => a.id === id_db);
    if (!anime) return;
    animeGrid.style.display = 'none';
    animeDetail.style.display = 'block';
    animeDetail.innerHTML = '';

    if (anime.synopsis) {
        renderDetail(anime);
        return;
    }

    UI.showModal('Carregando', 'Buscando detalhes...', []);
    try {
        const anilistId = parseInt(anime.mal_id);
        if (isNaN(anilistId)) throw new Error('ID do anime inválido.');

        const gqlQuery = `
            query ($id: Int) {
                Media(id: $id, type: ANIME) {
                    title { english romaji }
                    synonyms
                    description
                    genres
                    episodes
                    seasonYear
                    startDate { year }
                    coverImage { large }
                }
            }
        `;
        const data = await queryAniList(gqlQuery, { id: anilistId });
        const m = data?.Media;
        if (!m) throw new Error('Anime não encontrado na AniList.');

        const rawSynopsis = cleanDescription(m.description);
        const translationResult = await translateToPtBr(rawSynopsis);

        const bestEnglish = m.title?.english || (m.synonyms?.[0] || null);
        const updatedFields = {
            synopsis: translationResult.text,
            synopsis_lang: translationResult.success ? 'pt' : 'en',
            genres: m.genres || [],
            total_ep: m.episodes || 0,
            year: getBestYear(m),
            cover_url: anime.cover_url || m.coverImage?.large,
            title_english: bestEnglish,
            title_romaji: m.title?.romaji || null,
            title: bestEnglish || m.title?.romaji || anime.title
        };

        await updateAnimeFields(id_db, updatedFields);
        Object.assign(anime, updatedFields);
        UI.hideModal();
        renderDetail(anime);
    } catch (err) {
        UI.hideModal();
        UI.showModal('Erro', err.message || 'Falha ao obter detalhes.', [{ text: 'Ok', class: 'btn-confirm', action: UI.hideModal }]);
    }
}

function renderDetail(anime) {
    const synopsis = anime.synopsis || 'Sinopse não disponível.';
    const episodesStr = anime.total_ep || '?';
    const totalEps = parseInt(episodesStr);
    const year = anime.year || 'N/A';
    const genres = anime.genres ? anime.genres.join(', ') : '';
    const image = anime.cover_url;

    animeDetail.innerHTML = `
        <div class="detail-header">
            <img src="${image}" alt="${anime.title}">
            <div class="detail-overlay">
            <div>
            <div class="main-title-row">
                <h2>${anime.title}</h2>
            <button class="alt-title-btn copy-title-btn" id="copy-main-title" title="Copiar título">📋</button>
        </div>
        <div class="alt-titles" id="alt-titles"></div>
    </div>
    <button class="btn-back" id="back-btn">← Voltar</button>
    </div>
        </div>
        <div class="detail-body">
            <div class="detail-info">
                <h4>Sinopse</h4>
                <div class="synopsis-wrapper">
                    <p id="synopsis-text" class="synopsis-text collapsed">${synopsis}</p>
                    <button id="read-more-btn" class="read-more-btn">Ler mais</button>
                </div>
                <h4>Gestão de Status</h4>
                <div class="status-selector">
                    <label>Status Atual:</label>
                    <select id="status-select">
                        <option value="watching" ${anime.status === 'watching' ? 'selected' : ''}>🔵 Assistindo</option>
                        <option value="completed" ${anime.status === 'completed' ? 'selected' : ''}>✅ Concluído</option>
                        <option value="planned" ${anime.status === 'planned' ? 'selected' : ''}>⏳ Planejado</option>
                    </select>
                </div>
                <h4>Informações</h4>
                <div class="detail-stats">
                    <div class="stat-item"><span class="stat-label">Ano</span><span class="stat-value">${year}</span></div>
                    <div class="stat-item"><span class="stat-label">Episódios</span><span class="stat-value">${episodesStr}</span></div>
                    <div class="stat-item"><span class="stat-label">Gêneros</span><span class="stat-value">${genres}</span></div>
                    ${(() => {
                        const nextEp = nextEpisodeCache[parseInt(anime.mal_id)];
                        if (!nextEp) return '';
                        return `<div class="stat-item"><span class="stat-label">Próximo Episódio</span><span class="stat-value">Ep ${nextEp.episode} • ${formatAiringCountdown(nextEp.airingAt)}</span></div>`;
                    })()}
                </div>
                <div class="progress-tracker" id="progress-tracker">
                    <div id="progress-content"></div>
                </div>
                <div style="text-align: center; margin-top: 10px;">
                    <button id="edit-ep-btn" class="btn-modal btn-cancel" style="font-size: 0.8rem; padding: 5px 15px;">✏️ Editar Episódio</button>
                </div>
            </div>
            <div class="detail-sidebar"></div>
        </div>
    `;

    const mainTitleToCopy = anime.title_english || anime.title;
    const copyMainBtn = document.getElementById('copy-main-title');
if (copyMainBtn) {
    copyMainBtn.onclick = () => {
        navigator.clipboard.writeText(mainTitleToCopy);
        copyMainBtn.innerText = '✅';
        setTimeout(() => copyMainBtn.innerText = '📋', 1200);
    };
}

    const altTitlesContainer = document.getElementById('alt-titles');
if (altTitlesContainer) {
    const showRomaji = anime.title_romaji && anime.title_romaji !== anime.title;
    if (showRomaji) {
        altTitlesContainer.innerHTML = `
            <div class="alt-title-item">
                <span class="alt-title-label">Romaji:</span>
                <span class="alt-title-text">${anime.title_romaji}</span>
                <button class="alt-title-btn copy-title-btn" id="copy-romaji-title" title="Copiar">📋</button>
            </div>
        `;
        document.getElementById('copy-romaji-title').onclick = (e) => {
            navigator.clipboard.writeText(anime.title_romaji);
            e.target.innerText = '✅';
            setTimeout(() => e.target.innerText = '📋', 1200);
        };
    } else {
        altTitlesContainer.innerHTML = '';
    }
}

    const readMoreBtn = document.getElementById('read-more-btn');
    const synopsisText = document.getElementById('synopsis-text');
    if (readMoreBtn && synopsisText) {
        readMoreBtn.onclick = () => {
            const isCollapsed = synopsisText.classList.contains('collapsed');
            synopsisText.classList.toggle('collapsed');
            readMoreBtn.innerText = isCollapsed ? 'Ler menos' : 'Ler mais';
        };
    }

    const progressContent = document.getElementById('progress-content');
    const statusSelect = document.getElementById('status-select');

    const updateUI = () => {
        const currentEp = anime.current_ep;
        const percent = !isNaN(totalEps) ? Math.min(Math.max((currentEp / totalEps) * 100, 0), 100) : 0;

        if (anime.status === 'completed') {
            progressContent.innerHTML = `<div class="progress-status-msg">✨ Anime Concluído!</div>`;
        } else if (anime.status === 'planned') {
            progressContent.innerHTML = `<div class="progress-status-msg" style="color: var(--text-dim)">⏳ No Planejamento</div>`;
        } else {
            progressContent.innerHTML = `
                <div class="progress-header">
                    <h5>Progresso</h5>
                    <span class="prog-value" id="episode-val">Ep ${currentEp} / ${episodesStr}</span>
                </div>
                <div class="progress-bar-container">
                    <div class="progress-bar-fill" style="width: ${percent}%"></div>
                </div>
                <div class="progress-controls">
                    <button class="prog-btn" id="dec-ep">-</button>
                    <button class="prog-btn" id="inc-ep">+</button>
                </div>
            `;

            document.getElementById('inc-ep').onclick = async () => {
                const nextEp = (typeof anime.current_ep === 'number') ? anime.current_ep + 1 : 1;
                if (!isNaN(totalEps) && totalEps > 0 && nextEp > totalEps) return;
                anime.current_ep = nextEp;
                await updateAnimeFields(anime.id, { current_ep: anime.current_ep });
                updateUI();
            };

            document.getElementById('dec-ep').onclick = async () => {
                if (typeof anime.current_ep === 'number' && anime.current_ep > 0) {
                    anime.current_ep--;
                    await updateAnimeFields(anime.id, { current_ep: anime.current_ep });
                    updateUI();
                }
            };
        }
    };

    statusSelect.addEventListener('change', async () => {
        const newStatus = statusSelect.value;
        anime.status = newStatus;
        const fields = { status: newStatus };
        if (newStatus === 'completed' && !isNaN(totalEps)) {
            anime.current_ep = totalEps;
            fields.current_ep = totalEps;
        }
        await updateAnimeFields(anime.id, fields);
        updateUI();
        UI.showToast(`Status atualizado para ${getStatusLabel(newStatus)}`, 'success');
    });

    document.getElementById('back-btn').onclick = () => {
        animeDetail.style.display = 'none';
        animeGrid.style.display = 'grid';
        renderGrid(document.querySelector('.filter-btn.active').dataset.filter, searchInput.value.trim());
    };

    document.getElementById('edit-ep-btn').onclick = () => {
        UI.showModal('Atualizar Progresso', `
            <p>Em qual episódio você está?</p>
            <input type="number" id="manual-ep-input" value="${anime.current_ep}" style="width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-color); color: white; font-size: 1.2rem; text-align: center; margin-top: 10px;">
        `, [
            {
                text: 'Salvar',
                class: 'btn-confirm',
                action: async () => {
                    const val = document.getElementById('manual-ep-input').value;
                    if (val !== "") {
                        anime.current_ep = parseInt(val);
                        await updateAnimeFields(anime.id, { current_ep: anime.current_ep });
                        updateUI();
                        UI.hideModal();
                        UI.showToast(`Progresso atualizado: Ep ${anime.current_ep}`, 'success');
                    }
                }
            },
            { text: 'Cancelar', class: 'btn-cancel', action: UI.hideModal }
        ]);
    };

    updateUI();
}

async function deleteAnime(id_db) {
    const anime = myAnimeList.find(a => a.id === id_db);
    if (!anime) return;
    UI.showModal('Remover Anime', `Tem certeza que deseja remover <strong>${anime.title}</strong>?`, [
        {
            text: 'Sim, remover', class: 'btn-confirm', action: async () => {
                await removeAnime(id_db);
                await loadList();
                renderGrid(document.querySelector('.filter-btn.active').dataset.filter, searchInput.value.trim());
                UI.hideModal();
                UI.showToast(`"${anime.title}" removido da lista.`, 'info');
            }
        },
        { text: 'Cancelar', class: 'btn-cancel', action: UI.hideModal }
    ]);
}

// ---------- MIGRAÇÃO (rodar manualmente no console quando precisar) ----------

async function migrateOldSynopses() {
    const { data, error } = await supabaseClient
        .from('animes')
        .select('id, title, synopsis, synopsis_lang')
        .not('synopsis', 'is', null)
        .neq('synopsis_lang', 'pt');

    if (error) { console.error('Erro ao buscar animes para migração:', error); return; }
    if (!data || data.length === 0) { console.log('Nada para traduzir. Todos já estão em PT-BR.'); return; }

    console.log(`Iniciando tradução de ${data.length} anime(s)...`);
    let sucesso = 0, falha = 0;

    for (const anime of data) {
        const result = await translateToPtBr(anime.synopsis);
        if (result.success) {
            await supabaseClient
                .from('animes')
                .update({ synopsis: result.text, synopsis_lang: 'pt' })
                .eq('id', anime.id);
            console.log(`✅ Traduzido: ${anime.title}`);
            sucesso++;
        } else {
            console.warn(`❌ Falhou: ${anime.title}`);
            falha++;
        }
        await new Promise(r => setTimeout(r, 500));
    }

    console.log(`Migração concluída. Sucesso: ${sucesso} | Falhas: ${falha}`);
    await loadList();
    renderGrid(document.querySelector('.filter-btn.active').dataset.filter, '');
}

async function migrateOldTitles() {
    const { data: animes, error } = await supabaseClient
        .from('animes')
        .select('id, title, mal_id, title_english, title_romaji, year, total_ep');

    if (error) { console.error('Erro ao buscar animes:', error); return; }
    if (!animes || animes.length === 0) { console.log('Nenhum anime encontrado.'); return; }

    console.log(`Verificando dados de ${animes.length} anime(s)...`);
    let apiChamadas = 0, sucesso = 0, falha = 0, idsCorrigidos = 0, titulosCorrigidos = 0, semAlteracao = 0;
    const naoEncontrados = [];

    const gqlById = `
        query ($id: Int) {
            Media(id: $id, type: ANIME) {
                id
                title { english romaji }
                synonyms
                episodes
                seasonYear
                startDate { year }
            }
        }
    `;
    const gqlBySearch = `
        query ($search: String) {
            Page(perPage: 5) {
                media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
                    id
                    title { english romaji }
                    synonyms
                    episodes
                    seasonYear
                    startDate { year }
                }
            }
        }
    `;

    for (const anime of animes) {
        try {
            const updateFields = {};
            let englishTitle = anime.title_english;
            let romajiTitle = anime.title_romaji;

            // Precisa buscar na AniList se faltar romaji, faltar inglês (pode ter synonym), ano ou episódios
            const precisaBuscarNaAniList =
                romajiTitle === null || romajiTitle === undefined ||
                englishTitle === null || englishTitle === undefined ||
                !anime.year || !anime.total_ep;

            if (precisaBuscarNaAniList) {
                apiChamadas++;
                let media = null;
                const anilistId = parseInt(anime.mal_id);

                if (!isNaN(anilistId)) {
                    try {
                        const mediaData = await queryAniList(gqlById, { id: anilistId });
                        media = mediaData?.Media || null;
                    } catch (e) {
                        if (e.code !== 'NOT_FOUND') throw e;
                        media = null;
                    }
                }

                let idCorrigido = null;
                if (!media) {
                    const searchData = await queryAniList(gqlBySearch, { search: anime.title });
                    const candidato = searchData?.Page?.media?.[0] || null;
                    if (candidato) {
                        media = candidato;
                        idCorrigido = candidato.id;
                    }
                }

                if (!media) throw new Error('Não encontrado na AniList (nem por ID, nem por título)');

                romajiTitle = media.title?.romaji || romajiTitle || null;
                englishTitle = media.title?.english || media.synonyms?.[0] || null;

                updateFields.title_english = englishTitle;
                updateFields.title_romaji = romajiTitle;

                if (!anime.year) {
                    const bestYear = getBestYear(media);
                    if (bestYear) updateFields.year = bestYear;
                }
                if (!anime.total_ep && media.episodes) {
                    updateFields.total_ep = media.episodes;
                }

                if (idCorrigido && idCorrigido !== anilistId) {
                    updateFields.mal_id = idCorrigido;
                    idsCorrigidos++;
                }
                sucesso++;
            }

            const bestTitle = englishTitle || romajiTitle || anime.title;
            if (bestTitle !== anime.title) {
                updateFields.title = bestTitle;
                titulosCorrigidos++;
            }

            if (Object.keys(updateFields).length > 0) {
                await supabaseClient.from('animes').update(updateFields).eq('id', anime.id);
                const tag = updateFields.title ? ` → "${updateFields.title}"` : '';
                const idTag = updateFields.mal_id ? ` (ID: ${anime.mal_id} → ${updateFields.mal_id})` : '';
                console.log(`✅ ${anime.title}${tag}${idTag}`);
            } else {
                semAlteracao++;
            }
        } catch (e) {
            console.warn(`❌ Falhou: ${anime.title}`, e.message);
            naoEncontrados.push(anime.title);
            falha++;
        }
    }

    console.log(`Migração concluída. Chamadas à API: ${apiChamadas} | Sucesso: ${sucesso} | Falhas: ${falha} | Títulos corrigidos: ${titulosCorrigidos} | IDs corrigidos: ${idsCorrigidos} | Sem alteração: ${semAlteracao}`);
    if (naoEncontrados.length) console.log('Não encontrados (revisar manualmente):', naoEncontrados);
    await loadList();
    renderGrid(document.querySelector('.filter-btn.active').dataset.filter, '');
}

// ---------- EVENTOS ----------

searchBtn.addEventListener('click', () => {
    clearTimeout(searchTimeout);
    fetchSuggestions();
});

searchInput.addEventListener('keypress', e => {
    if (e.key === 'Enter') {
        clearTimeout(searchTimeout);
        fetchSuggestions();
    }
});

clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    searchResults.style.display = 'none';
    searchRequestId++;
    renderGrid(document.querySelector('.filter-btn.active').dataset.filter, '');
});

document.addEventListener('click', (e) => {
    const isClickInsideSearch = searchInput.contains(e.target) || searchResults.contains(e.target) || searchBtn.contains(e.target);
    if (!isClickInsideSearch) {
        searchResults.style.display = 'none';
    }
});

searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    clearBtn.style.display = q.length ? 'flex' : 'none';
    const activeFilter = document.querySelector('.filter-btn.active').dataset.filter;
    renderGrid(activeFilter, q);
    clearTimeout(searchTimeout);

    if (q.length < 3) { searchRequestId++; searchResults.style.display = 'none'; return; }

    // Se já temos cache pra esse termo, mostra na hora, sem esperar o debounce
    const cached = getSearchCache(normalizeSearchQuery(q));
    if (cached) {
        searchRequestId++; // invalida qualquer busca anterior ainda pendente
        renderSearchOutcome(cached);
        return;
    }

    searchTimeout = setTimeout(fetchSuggestions, 400);
});

searchInput.addEventListener('focus', () => {
    const q = searchInput.value.trim();
    if (q.length >= 3 && searchResults.innerHTML.trim() !== '') {
        searchResults.style.display = 'block';
    }
});

closeModal.addEventListener('click', UI.hideModal);

filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderGrid(btn.dataset.filter, searchInput.value.trim());
    });
});

sortSelect.addEventListener('change', () => {
    renderGrid(document.querySelector('.filter-btn.active').dataset.filter, searchInput.value.trim());
});

genreSelect.addEventListener('change', () => {
    renderGrid(document.querySelector('.filter-btn.active').dataset.filter, searchInput.value.trim());
});

// ---------- ATALHOS DE TECLADO ----------

function getVisibleCards() {
    return Array.from(animeGrid.querySelectorAll('.anime-card'));
}

function getGridColumns() {
    const cols = getComputedStyle(animeGrid).gridTemplateColumns.split(' ');
    return cols.length || 1;
}

function setFocusedCard(index) {
    const cards = getVisibleCards();
    cards.forEach(c => c.classList.remove('card-focused'));
    if (index < 0 || index >= cards.length) { focusedCardIndex = -1; return; }
    focusedCardIndex = index;
    cards[index].classList.add('card-focused');
    cards[index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function showShortcutsHelp() {
    UI.showModal('Atalhos de Teclado', `
        <div class="shortcut-row"><span>Focar na busca</span><kbd>/</kbd></div>
        <div class="shortcut-row"><span>Fechar / voltar / limpar</span><kbd>Esc</kbd></div>
        <div class="shortcut-row"><span>Assistindo</span><kbd>1</kbd></div>
        <div class="shortcut-row"><span>Concluídos</span><kbd>2</kbd></div>
        <div class="shortcut-row"><span>Planejados</span><kbd>3</kbd></div>
        <div class="shortcut-row"><span>Navegar pelos cards</span><kbd>← ↑ → ↓</kbd></div>
        <div class="shortcut-row"><span>Abrir card selecionado</span><kbd>Enter</kbd></div>
        <div class="shortcut-row"><span>Mostrar esta ajuda</span><kbd>?</kbd></div>
    `, [{ text: 'Ok', class: 'btn-confirm', action: UI.hideModal }]);
}

document.addEventListener('keydown', (e) => {
    const activeTag = document.activeElement.tagName;
    const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag);
    const modalOpen = modal.style.display === 'flex';
    const inDetailView = animeDetail.style.display === 'block';

    // Esc funciona sempre, mesmo digitando — em cascata, do mais "no topo" pro mais "no fundo"
    if (e.key === 'Escape') {
        if (modalOpen) { UI.hideModal(); return; }
        if (inDetailView) { document.getElementById('back-btn')?.click(); return; }
        if (searchResults.style.display === 'block') { searchResults.style.display = 'none'; return; }
        if (searchInput.value) { clearBtn.click(); return; }
        searchInput.blur();
        return;
    }

    if (isTyping || modalOpen) return; // demais atalhos não valem enquanto digita ou com modal aberto

    if (e.key === '/') {
        e.preventDefault();
        searchInput.focus();
        return;
    }

    if (e.key === '?') {
        e.preventDefault();
        showShortcutsHelp();
        return;
    }

    if (!inDetailView && ['1', '2', '3'].includes(e.key)) {
        const map = { '1': 'watching', '2': 'completed', '3': 'planned' };
        document.querySelector(`.filter-btn[data-filter="${map[e.key]}"]`)?.click();
        return;
    }

    if (!inDetailView) {
        const cards = getVisibleCards();
        if (cards.length === 0) return;
        const cols = getGridColumns();

        if (e.key === 'ArrowRight') {
            e.preventDefault();
            setFocusedCard(Math.min((focusedCardIndex < 0 ? -1 : focusedCardIndex) + 1, cards.length - 1));
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            setFocusedCard(Math.max(focusedCardIndex - 1, 0));
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setFocusedCard(Math.min((focusedCardIndex < 0 ? 0 : focusedCardIndex + cols), cards.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setFocusedCard(Math.max(focusedCardIndex - cols, 0));
        } else if (e.key === 'Enter' && focusedCardIndex >= 0) {
            e.preventDefault();
            cards[focusedCardIndex].click();
        }
    }
});

// ---------- SWIPE MOBILE (trocar categoria arrastando) ----------

let touchStartX = 0;
let touchStartY = 0;

function handleCategorySwipe(deltaX) {
    const order = Array.from(filterBtns).map(b => b.dataset.filter);
    const activeBtn = document.querySelector('.filter-btn.active');
    const currentIndex = order.indexOf(activeBtn.dataset.filter);
    let newIndex = currentIndex;

    if (deltaX < 0 && currentIndex < order.length - 1) {
        newIndex = currentIndex + 1; // swipe para a esquerda -> próxima categoria
    } else if (deltaX > 0 && currentIndex > 0) {
        newIndex = currentIndex - 1; // swipe para a direita -> categoria anterior
    }

    if (newIndex !== currentIndex) {
        document.querySelector(`.filter-btn[data-filter="${order[newIndex]}"]`)?.click();
    }
}

mainContent.addEventListener('touchstart', (e) => {
    if (animeGrid.style.display === 'none') return; // ignora dentro da tela de detalhes
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
}, { passive: true });

mainContent.addEventListener('touchend', (e) => {
    if (animeGrid.style.display === 'none') return;
    const touchEndX = e.changedTouches[0].screenX;
    const touchEndY = e.changedTouches[0].screenY;
    const deltaX = touchEndX - touchStartX;
    const deltaY = touchEndY - touchStartY;

    const SWIPE_THRESHOLD = 60;
    const isHorizontal = Math.abs(deltaX) > Math.abs(deltaY);

    if (isHorizontal && Math.abs(deltaX) > SWIPE_THRESHOLD) {
        handleCategorySwipe(deltaX);
    }
}, { passive: true });

function updateGenreDropdown() {
    const genres = new Set();
    myAnimeList.forEach(anime => {
        if (anime.genres) anime.genres.forEach(g => genres.add(g));
    });
    const sortedGenres = Array.from(genres).sort();
    const currentVal = genreSelect.value;
    genreSelect.innerHTML = '<option value="all">Todas as Categorias</option>';
    sortedGenres.forEach(genre => {
        const option = document.createElement('option');
        option.value = genre;
        option.innerText = genre;
        genreSelect.appendChild(option);
    });
    genreSelect.value = currentVal;
}

async function initApp() {
    await loadList();
    renderGrid('watching');
    refreshLiveAniListData().then(() => {
        renderGrid(document.querySelector('.filter-btn.active').dataset.filter, searchInput.value.trim());
    });
}

window.addEventListener('load', async () => {
    cleanupSearchCache();
    const isLoggedIn = await checkUserSession();
    if (isLoggedIn) {
        await initApp();
    }
    loginForm.addEventListener('submit', handleLogin);
});