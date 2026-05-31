const API_URL = 'https://api.jikan.moe/v4';
const SUPABASE_URL = 'https://pebpxvymmoqlezsqewyt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_OEMXXgntsFTGS-N-Ve9ZCg_QAf8GM2W';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let myAnimeList = [];
let currentSelectedAnime = null;
let searchTimeout = null;

// ---------- DOM ELEMENTS ----------
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

// ---------- UI HELPER ----------
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

// ---------- DATABASE LOGIC ----------

async function loadList() {
    const { data, error } = await supabaseClient
        .from('animes')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Error loading anime list:', error);
        return;
    }
    myAnimeList = data;
    updateGenreDropdown();
}

async function syncLocalStorage() {
    const localDataRaw = localStorage.getItem('animeOS_list');
    if (!localDataRaw) return;
    
    const localData = JSON.parse(localDataRaw);
    if (!localData || localData.length === 0) return;

    console.log('Found local data, migrating...');

    const dbData = localData.map(anime => ({
        mal_id: anime.id, 
        title: anime.title,
        status: anime.status,
        current_ep: anime.currentEpisode || 0,
        total_ep: anime.episodes === '?' ? 0 : parseInt(anime.episodes),
        cover_url: anime.image,
        year: anime.year === 'N/A' ? null : parseInt(anime.year),
        synopsis: anime.fullInfo ? anime.fullInfo.synopsis : null,
        genres: anime.fullInfo ? anime.fullInfo.genres.map(g => g.name) : [],
        status_label: anime.statusLabel 
    }));

    const { error } = await supabaseClient.from('animes').insert(dbData);
    if (!error) {
        localStorage.removeItem('animeOS_list');
        console.log('LocalStorage migrated to Supabase successfully!');
        await loadList();
    } else {
        console.error('Migration error:', error);
    }
}

async function saveAnime(anime) {
    const dbId = anime.id; 

    if (dbId && typeof dbId === 'string' && dbId.length > 20) {
        const { error } = await supabaseClient
            .from('animes')
            .update({
                status: anime.status,
                current_ep: anime.current_ep || anime.currentEpisode,
                total_ep: anime.total_ep || (anime.episodes === '?' ? 0 : parseInt(anime.episodes))
            })
            .eq('id', dbId);
        if (error) console.error('Update error:', error);
    } else {
        const { data, error } = await supabaseClient
            .from('animes')
            .insert([{
                mal_id: anime.id || anime.mal_id,
                title: anime.title,
                status: anime.status,
                current_ep: anime.current_ep || anime.currentEpisode || 0,
                total_ep: anime.total_ep || (anime.episodes === '?' ? 0 : parseInt(anime.episodes)),
                cover_url: anime.image || anime.cover_url,
                year: anime.year === 'N/A' ? null : parseInt(anime.year),
                genres: anime.fullInfo ? anime.fullInfo.genres.map(g => g.name) : (anime.genres || []),
                synopsis: anime.fullInfo ? anime.// l's missing... just fixing in write
                synopsis: anime.fullInfo ? anime.fullInfo.synopsis : (anime.synopsis || null)
            }])
            .select();
        if (error) console.error('Insert error:', error);
        else if (data) anime.id = data[0].id;
    }
}

async function removeAnime(id_db) {
    const { error } = await supabaseClient.from('animes').delete().eq('id', id_db);
    if (error) console.error('Delete error:', error);
}

// ---------- CORE LOGIC ----------

async function fetchSuggestions() {
    const query = searchInput.value.trim();
    if (query.length < 3) { searchResults.style.display = 'none'; return; }
    try {
        const resp = await fetch(`${API_URL}/anime?q=${encodeURIComponent(query)}&limit=20`);
        const data = await resp.json();
        if (data.data && data.data.length) {
            renderSuggestions(data.data);
        } else {
            searchResults.style.display = 'none';
        }
    } catch (e) { console.error(e); searchResults.style.display = 'none'; }
}

function renderSuggestions(animes) {
    searchResults.innerHTML = '';
    searchResults.style.display = 'block';
    animes.forEach(anime => {
        const item = document.createElement('div');
        item.className = 'result-item';
        item.innerHTML = `<img src="${anime.images.jpg.image_url}" alt="${anime.title}"><span class="title">${anime.title}</span>`;
        item.onclick = () => {
            currentSelectedAnime = anime;
            showStatusPicker();
            searchResults.style.display = 'none';
            searchInput.value = anime.title;
        };
        searchResults.appendChild(item);
    });
}

async function searchAnime() {
    const query = searchInput.value.trim();
    if (!query) return;
    searchBtn.innerText = '...';
    try {
        const resp = await fetch(`${API_URL}/anime?q=${encodeURIComponent(query)}&limit=1`);
        const data = await resp.json();
        if (data.data && data.data.length) {
            const anime = data.data[0];
            UI.showModal('Confirmar Adição', `
                <div style="display:flex;gap:20px;align-items:center;">
                    <img src="${anime.images.jpg.image_url}" style="width:100px;border-radius:8px;" />
                    <div>
                        <strong>${anime.title}</strong><br/>
                        <small>Ano: ${anime.year || 'N/A'}</small><br/>
                        <small>Episódios: ${anime.episodes || '?'}</small><br/>
                        <small>Gêneros: ${anime.genres.map(g=>g.name).join(', ')}</small>
                    </div>
                </div>
            `, [
                {text:'Adicionar', class:'btn-confirm', action:()=>{currentSelectedAnime = anime; showStatusPicker();}},
                {text:'Cancelar', class:'btn-cancel', action:UI.hideModal}
            ]);
        } else {
            UI.showModal('Erro', 'Anime não encontrado no MAL.', [{text:'Ok', class:'btn-confirm', action:UI.hideModal}]);
        }
    } catch (e) {
        UI.showModal('Erro', 'Problema ao conectar à API.', [{text:'Tentar novamente', class:'btn-confirm', action:searchAnime}]);
    } finally { searchBtn.innerText = '🔍 Buscar'; }
}

function showStatusPicker() {
    const anime = currentSelectedAnime;
    UI.showModal('Definir Status', `
        <p style="margin-bottom:15px;">Em qual categoria deseja adicionar <strong>${anime.title}</strong>?</p>
        <div style="display:grid;gap:10px;">
            <button class="btn-modal btn-cancel status-opt" data-status="watching" data-label="Assistindo">🔵 Assistindo</button>
            <button class="btn-modal btn-cancel status-opt" data-status="completed" data-label="Concluído">✅ Concluído</button>
            <button class="btn-modal btn-cancel status-opt" data-status="planned" data-label="Planejado">⏳ Planejado</button>
        </div>
    `, []);
    document.querySelectorAll('.status-opt').forEach(btn => {
        btn.onclick = () => { finalizeAdd(btn.dataset.status, btn.dataset.label); };
    });
}

async function finalizeAdd(status, label) {
    const anime = currentSelectedAnime;
    
    // Mostrar loading no modal para o usuário saber que estamos buscando os detalhes completos
    UI.showModal('Sincronizando...', 'Buscando detalhes completos no MAL para habilitar filtros...', []);

    try {
        // Buscar detalhes completos IMEDIATAMENTE no momento da adição
        const resp = await fetch(`${API_URL}/anime/${anime.mal_id}/full`);
        const data = await resp.json();
        const fullInfo = data.data;

        const newAnime = {
            id: anime.mal_id,
            title: anime.title,
            image: anime.images.jpg.image_url,
            year: fullInfo.year || anime.year || 'N/A',
            episodes: fullInfo.episodes || anime.episodes || '?',
            status: status,
            statusLabel: label,
            currentEpisode: 0,
            currentSeason: 1,
            // Já enviamos os detalhes completos para o Supabase
            synopsis: fullInfo.synopsis,
            genres: fullInfo.genres ? fullInfo.genres.map(g => g.name) : [],
            fullInfo: fullInfo
        };
        
        await saveAnime(newAnime);
        await loadList();
        
        searchInput.value = '';
        clearBtn.style.display = 'none';
        UI.hideModal();
        renderGrid(document.querySelector('.filter-btn.active').dataset.filter, searchInput.value.trim());
    } catch (e) {
        console.error('Erro ao buscar detalhes na adição:', e);
        UI.hideModal();
        // Fallback: adiciona mesmo sem detalhes completos para não travar o usuário
        const fallbackAnime = {
            id: anime.mal_id,
            title: anime.title,
            image: anime.images.jpg.image_url,
            status: status,
            statusLabel: label,
            currentEpisode: 0
        };
        await saveAnime(fallbackAnime);
        await loadList();
        renderGrid(document.querySelector('.filter-btn.active').dataset.filter, searchInput.value.trim());
    }
}

async function renderGrid(filter = 'watching', searchTerm = '') {
    await loadList();
    animeGrid.innerHTML = '';
    
    let filtered = filter === 'all' ? [...myAnimeList] : myAnimeList.filter(a => a.status === filter);
    
    // Category Filter
    const selectedGenre = genreSelect.value;
    if (selectedGenre !== 'all') {
        filtered = filtered.filter(a => a.genres && a.genres.includes(selectedGenre));
    }

    // Search Term Filter
    if (searchTerm) {
        filtered = filtered.filter(a => a.title.toLowerCase().includes(searchTerm.toLowerCase()));
    }

    // Sorting
    const sortType = sortSelect.value;
    if (sortType === 'alpha') {
        filtered.sort((a, b) => a.title.localeCompare(b.title));
    } else if (sortType === 'recent') {
        // Supabase already returns ordered by created_at desc
    }

    filtered.forEach((anime) => {
        const card = document.createElement('div');
        card.className = 'anime-card';
        card.dataset.id = anime.id;
        
        let metaContent = `<span>${anime.year}</span>`;
        if (anime.status === 'watching') {
            metaContent += `<span class="current-ep">Ep ${anime.current_ep}/${anime.total_ep}</span>`;
        } else {
            metaContent += `<span>${anime.total_ep} eps</span>`;
        }

        card.innerHTML = `
            <button class="delete-btn" onclick="deleteAnime('${anime.id}')">×</button>
            <span class="status-badge badge-${anime.status}">
                ${anime.status === 'watching' ? 'Assistindo' : anime.status === 'completed' ? 'Concluído' : 'Planejado'}
            </span>
            <img src="${anime.cover_url}" alt="${anime.title}">
            <div class="card-info">
                <h3>${anime.title}</h3>
                <div class="card-meta">${metaContent}</div>
            </div>
        `;
        card.addEventListener('click', e => {
            if (e.target.closest('.delete-btn')) return;
            showDetail(anime.id);
        });
        animeGrid.appendChild(card);
    });
}

async function deleteAnime(id_db) {
    const anime = myAnimeList.find(a => a.id === id_db);
    if (!anime) return;
    UI.showModal('Remover Anime', `Tem certeza que deseja remover <strong>${anime.title}</strong>?`, [
        {text:'Sim, remover', class:'btn-confirm', action:async()=>{
            await removeAnime(id_db);
            await loadList();
            renderGrid(document.querySelector('.filter-btn.active').dataset.filter, searchInput.value.trim()); 
            UI.hideModal();
        }},
        {text:'Cancelar', class:'btn-cancel', action:UI.hideModal}
    ]);
}

async function showDetail(id_db) {
    const anime = myAnimeList.find(a => a.id === id_db);
    if (!anime) return;
    
    animeGrid.style.display = 'none';
    animeDetail.style.display = 'block';
    animeDetail.innerHTML = '';
    
    if (anime.synopsis) {
        renderDetail(anime);
    } else {
        UI.showModal('Carregando', 'Buscando detalhes...', []);
        try {
            const resp = await fetch(`${API_URL}/anime/${anime.mal_id}/full`);
            const data = await resp.json();
            UI.hideModal();
            
            await supabaseClient.from('animes').update({
                synopsis: data.data.synopsis,
                genres: data.data.genres.map(g => g.name),
                total_ep: data.data.episodes || 0
            }).eq('id', id_db);
            
            anime.synopsis = data.data.synopsis;
            anime.genres = data.data.genres.map(g => g.name);
            anime.total_ep = data.data.episodes || 0;
            
            renderDetail(anime);
        } catch (err) {
            UI.hideModal();
            console.error(err);
            UI.showModal('Erro', 'Falha ao obter detalhes.', [{text:'Ok', class:'btn-confirm', action:UI.hideModal}]);
        }
    }
}

function renderDetail(anime) {
    const synopsis = anime.synopsis || 'Sinopse não disponível.';
    const episodesStr = anime.total_ep || '?';
    const totalEps = parseInt(episodesStr);
    const year = anime.year || 'N/A';
    const genres = anime.genres ? anime.genres.join(', ') : '';
    const image = anime.cover_url;

    const detailHTML = `
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
                <p>${synopsis}</p>
                
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
    animeDetail.innerHTML = detailHTML;

    const progressContent = document.getElementById('progress-content');
    const statusSelect = document.getElementById('status-select');

    const updateUI = async () => {
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
                await saveAnime(anime);
                updateUI(); 
            };
            document.getElementById('dec-ep').onclick = async () => { 
                if (typeof anime.current_ep === 'number' && anime.current_ep > 0) {
                    anime.current_ep--;
                    await saveAnime(anime);
                    updateUI(); 
                }
            };
        }
    };

    statusSelect.addEventListener('change', async () => {
        const newStatus = statusSelect.value;
        anime.status = newStatus;

        if (newStatus === 'completed') {
            if (!isNaN(totalEps)) {
                anime.current_ep = totalEps;
            }
        }
        
        await saveAnime(anime);
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
                        await saveAnime(anime);
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

// ---------- EVENT LISTENERS ----------
searchBtn.addEventListener('click', searchAnime);
searchInput.addEventListener('keypress', e => { if (e.key === 'Enter') searchAnime(); });
clearBtn.addEventListener('click', () => { searchInput.value=''; clearBtn.style.display='none'; searchResults.style.display='none'; renderGrid(document.querySelector('.filter-btn.active').dataset.filter, ''); });
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

// NEW: Sort and Category listeners
sortSelect.addEventListener('change', () => {
    renderGrid(document.querySelector('.filter-btn.active').dataset.filter, searchInput.value.trim());
});

genreSelect.addEventListener('change', () => {
    renderGrid(document.querySelector('.filter-btn.active').dataset.filter, searchInput.value.trim());
});

function updateGenreDropdown() {
    const genres = new Set();
    myAnimeList.forEach(anime => {
        if (anime.genres) {
            anime.genres.forEach(g => genres.add(g));
        }
    });

    const sortedGenres = Array.from(genres).sort();
    
    // Save current value to restore it after rebuild
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

// Init
window.addEventListener('load', async () => { 
    await syncLocalStorage();
    await loadList();
    renderGrid('watching'); 
});
