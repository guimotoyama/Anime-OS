const API_URL = 'https://graphql.anilist.co';
const SUPABASE_URL = 'https://pebpxvymmoqlezsqewyt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_OEMXXgntsFTGS-N-Ve9ZCg_QAf8GM2W';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let myAnimeList = [];
let currentSelectedAnime = null;
let searchTimeout = null;

async function queryAniList(query, variables = {}, retries = 2) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query, variables }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if ((response.status === 429 || response.status >= 500) && retries > 0) {
            await new Promise(r => setTimeout(r, 800));
            return queryAniList(query, variables, retries - 1);
        }
        if (!response.ok) throw new Error(`Erro na AniList: ${response.status}`);

        const json = await response.json();
        if (json.errors) throw new Error(json.errors[0].message);
        return json.data;
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('A busca demorou demais para responder. Tente novamente.');
        throw e;
    }
}

function getBestTitle(titleObj) {
    if (!titleObj) return 'Título Indisponível';
    return titleObj.english || titleObj.romaji || titleObj.native || 'Título Indisponível';
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
        try {
            const translated = await translateToPtBr(anime.synopsis);
            await supabaseClient
                .from('animes')
                .update({ synopsis: translated, synopsis_lang: 'pt' })
                .eq('id', anime.id);
            console.log(`✅ Traduzido: ${anime.title}`);
            sucesso++;
        } catch (e) {
            console.warn(`❌ Falhou: ${anime.title}`, e.message);
            falha++;
        }
        await new Promise(r => setTimeout(r, 500)); // evita sobrecarregar o serviço gratuito
    }

    console.log(`Migração concluída. Sucesso: ${sucesso} | Falhas: ${falha}`);
    await loadList();
    renderGrid(document.querySelector('.filter-btn.active').dataset.filter, '');
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
        return { text, success: false };
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
    const { error } = await supabaseClient.from('animes').insert([{
        mal_id: anime.mal_id,
        title: anime.title,
        status: anime.status,
        current_ep: anime.current_ep || 0,
        total_ep: anime.total_ep || 0,
        cover_url: anime.cover_url,
        year: anime.year,
        genres: anime.genres || [],
        synopsis: anime.synopsis || null,
        synopsis_lang: anime.synopsis_lang || 'pt'
    }]);
    if (error) console.error('Erro ao adicionar anime:', error);
}

async function updateAnimeFields(id, fields) {
    const { error } = await supabaseClient.from('animes').update(fields).eq('id', id);
    if (error) console.error('Erro ao atualizar anime:', error);
}

async function removeAnime(id_db) {
    await supabaseClient.from('animes').delete().eq('id', id_db);
}

// ---------- BUSCA DE NOVOS ANIMES (AniList) ----------

async function fetchSuggestions() {
    const query = searchInput.value.trim();
    if (query.length < 3) { searchResults.style.display = 'none'; return; }

    const gqlQuery = `
        query ($search: String) {
            Page(perPage: 15) {
                media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
                    id
                    title { english romaji native }
                    coverImage { large }
                    seasonYear
                    episodes
                    genres
                    description
                }
            }
        }
    `;
    try {
        const data = await queryAniList(gqlQuery, { search: query });
        const animes = data?.Page?.media || [];
        if (animes.length > 0) {
            renderSuggestions(animes);
        } else {
            searchResults.innerHTML = '<div style="padding:15px;color:var(--text-dim);">Nenhum resultado encontrado.</div>';
            searchResults.style.display = 'block';
        }
    } catch (e) {
        console.warn('Busca falhou:', e.message);
        searchResults.innerHTML = `<div style="padding:15px;color:var(--text-dim);">${e.message}</div>`;
        searchResults.style.display = 'block';
    }
}

function renderSuggestions(animes) {
    searchResults.innerHTML = '';
    searchResults.style.display = 'block';
    animes.forEach(anime => {
        const title = getBestTitle(anime.title);
        const imgUrl = anime.coverImage?.large || 'https://via.placeholder.com/40x60?text=No+Img';
        const item = document.createElement('div');
        item.className = 'result-item';
        item.innerHTML = `<img src="${imgUrl}" alt="${title}"><span class="title">${title}</span>`;
        item.onclick = () => {
            currentSelectedAnime = anime;
            showStatusPicker();
            searchResults.style.display = 'none';
        };
        searchResults.appendChild(item);
    });
}

function showStatusPicker() {
    const anime = currentSelectedAnime;
    UI.showModal('Definir Status', `
        <p style="margin-bottom:15px;">Em qual categoria deseja adicionar <strong>${getBestTitle(anime.title)}</strong>?</p>
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
    title: getBestTitle(anime.title),
    cover_url: anime.coverImage?.large,
    year: anime.seasonYear || null,
    total_ep: totalEp,
    status: status,
    current_ep: status === 'completed' ? totalEp : 0,
    synopsis: translationResult.text,
    synopsis_lang: translationResult.success ? 'pt' : 'en',
    genres: anime.genres || [],
};
    await addAnimeToDB(newAnime);
    await loadList();
    searchInput.value = '';
    clearBtn.style.display = 'none';
    UI.hideModal();
    renderGrid(document.querySelector('.filter-btn.active').dataset.filter, '');
}

// ---------- GRID PRINCIPAL ----------

function renderGrid(filter, query = '') {
    let list = myAnimeList.filter(a => a.status === filter);

    if (query) {
        const q = query.toLowerCase();
        list = list.filter(a => a.title.toLowerCase().includes(q));
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
                    description
                    genres
                    episodes
                    seasonYear
                    coverImage { large }
                }
            }
        `;
        const data = await queryAniList(gqlQuery, { id: anilistId });
        const m = data?.Media;
        if (!m) throw new Error('Anime não encontrado na AniList.');

        const rawSynopsis = cleanDescription(m.description);
        const translationResult = await translateToPtBr(rawSynopsis);

const updatedFields = {
    synopsis: translationResult.text,
    synopsis_lang: translationResult.success ? 'pt' : 'en',
    genres: m.genres || [],
    total_ep: m.episodes || 0,
    year: m.seasonYear || null,
    cover_url: anime.cover_url || m.coverImage?.large
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
                <h2>${anime.title}</h2>
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
                anime.current_ep = (typeof anime.current_ep === 'number') ? anime.current_ep + 1 : 1;
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
            }
        },
        { text: 'Cancelar', class: 'btn-cancel', action: UI.hideModal }
    ]);
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
    renderGrid(document.querySelector('.filter-btn.active').dataset.filter, '');
});

searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    clearBtn.style.display = q.length ? 'flex' : 'none';
    const activeFilter = document.querySelector('.filter-btn.active').dataset.filter;
    renderGrid(activeFilter, q);
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(fetchSuggestions, 400);
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
}

window.addEventListener('load', async () => {
    const isLoggedIn = await checkUserSession();
    if (isLoggedIn) {
        await initApp();
    }
    loginForm.addEventListener('submit', handleLogin);
});