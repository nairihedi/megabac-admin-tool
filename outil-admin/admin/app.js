// ============================================================================
// Catalogue des niveaux (identique à www/js/niveaux.js de l'app)
// ============================================================================
const NIVEAUX_CATALOGUE = [
{ code: '11', libelle: 'CP' }, { code: '10', libelle: 'CE1' },
{ code: '9', libelle: 'CE2' }, { code: '8', libelle: 'CM1' },
{ code: '7', libelle: 'CM2' }, { code: '6', libelle: '6ème' },
{ code: '5', libelle: '5ème' }, { code: '4', libelle: '4ème' },
{ code: '3', libelle: '3ème' }, { code: '2', libelle: '2nde' },
{ code: '1', libelle: '1ère' }, { code: '0', libelle: 'Terminale' },
];
function libelleNiveau(code) {
return NIVEAUX_CATALOGUE.find((n) => n.code === String(code))?.libelle || `Niveau ${code}`;
}

// ============================================================================
// État
// ============================================================================
const state = {
root: null,
niveaux: [],            // codes trouvés sur le disque
niveauCourant: null,
niveauDir: null,
niveauVersion: 1,
matieres: [],
matiereCourante: null,
ongletMatiere: 'cours', // 'cours' | 'exercices' | 'epreuves'
};

const elLayout = document.getElementById('layout');
const elAccueil = document.getElementById('accueil');
const elSidebar = document.getElementById('sidebar');
const elMain = document.getElementById('main');
const elChemin = document.getElementById('cheminActuel');

function toast(msg) {
const el = document.createElement('div');
el.className = 'toast';
el.textContent = msg;
document.body.appendChild(el);
setTimeout(() => el.remove(), 2400);
}
function echap(s = '') {
return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function genererId(prefixe) {
return `${prefixe}-${Math.random().toString(36).slice(2, 7)}`;
}

// Comme echap(), mais laisse passer les <img src="data:image/...;base64,..."> générées
// par l'outil d'import d'image, pour les afficher dans les aperçus.
function echapAvecImages(s = '') {
return echap(s).replace(
/&lt;img src=&quot;(data:image\/[a-z+.-]+;base64,[A-Za-z0-9+\/=]+)&quot; alt=&quot;&quot;&gt;/g,
'<img src="$1" alt="">'
);
}

// Redimensionne les images raster trop larges pour garder des JSON raisonnables.
const IMAGE_LARGEUR_MAX = 800;
function fichierVersDataUri(fichier) {
return new Promise((resolve, reject) => {
const lecteur = new FileReader();
lecteur.onerror = () => reject(new Error('Lecture du fichier impossible.'));
lecteur.onload = () => {
const uri = lecteur.result;
if (fichier.type === 'image/svg+xml' || fichier.type === 'image/gif') return resolve(uri);
const img = new Image();
img.onerror = () => reject(new Error("Ce fichier n'est pas une image valide."));
img.onload = () => {
if (img.width <= IMAGE_LARGEUR_MAX) return resolve(uri);
const canvas = document.createElement('canvas');
canvas.width = IMAGE_LARGEUR_MAX;
canvas.height = Math.round(img.height * IMAGE_LARGEUR_MAX / img.width);
canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
resolve(canvas.toDataURL(fichier.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85));
};
img.src = uri;
};
lecteur.readAsDataURL(fichier);
});
}

// Ajoute un bouton « Insérer une image » sous chaque <textarea data-image> de la racine.
// L'image est insérée en base64 à la position du curseur, sous forme de balise <img>.
function activerImportImage(racine) {
racine.querySelectorAll('textarea[data-image]').forEach((ta) => {
if (ta.dataset.imageActive) return;
ta.dataset.imageActive = '1';
const bouton = document.createElement('button');
bouton.type = 'button';
bouton.className = 'discret';
bouton.textContent = '🖼 Insérer une image';
const input = document.createElement('input');
input.type = 'file';
input.accept = 'image/*';
input.hidden = true;
bouton.addEventListener('click', () => input.click());
input.addEventListener('change', async () => {
const fichier = input.files[0];
input.value = '';
if (!fichier) return;
try {
const uri = await fichierVersDataUri(fichier);
const balise = `<img src="${uri}" alt="">`;
const debut = ta.selectionStart ?? ta.value.length;
const fin = ta.selectionEnd ?? ta.value.length;
ta.value = ta.value.slice(0, debut) + balise + ta.value.slice(fin);
ta.focus();
ta.setSelectionRange(debut + balise.length, debut + balise.length);
ta.dispatchEvent(new Event('input', { bubbles: true }));
toast(`Image insérée (${Math.round(uri.length / 1024)} Ko).`);
} catch (e) {
toast(e.message);
}
});
ta.insertAdjacentElement('afterend', bouton);
bouton.insertAdjacentElement('afterend', input);
});
}

// ============================================================================
// Utilitaires File System Access API
// ============================================================================
async function getOrCreateDir(parent, name) {
return parent.getDirectoryHandle(name, { create: true });
}
async function readJson(dir, filename, defaut) {
try {
  const fh = await dir.getFileHandle(filename);
  const file = await fh.getFile();
  const texte = await file.text();
  return texte.trim() ? JSON.parse(texte) : defaut;
} catch {
  return defaut;
}
}
async function writeJson(dir, filename, valeur) {
const fh = await dir.getFileHandle(filename, { create: true });
const writable = await fh.createWritable();
await writable.write(JSON.stringify(valeur, null, 2));
await writable.close();
}
async function removeEntrySilencieux(dir, name, options) {
try { await dir.removeEntry(name, options); } catch { /* déjà absent, tant mieux */ }
}
async function listerSousDossiers(dir) {
const noms = [];
for await (const [name, handle] of dir.entries()) {
  if (handle.kind === 'directory') noms.push(name);
}
return noms;
}

async function bumpVersion(dir) {
const data = await readJson(dir, 'version.json', { version: 0 });
data.version = (data.version || 0) + 1;
await writeJson(dir, 'version.json', data);
return data.version;
}

// ============================================================================
// Démarrage — mode local (choix du dossier) ou distant (connexion au serveur)
// Le mode est choisi sur la page d'accueil : admin.html?mode=local
// ou admin.html?mode=distant&backend=php|aspnet
// ============================================================================
const paramsUrl = new URLSearchParams(location.search);
const modeAdmin = paramsUrl.get('mode');
const elBtnDossier = document.getElementById('btnChoisirDossier');
const elBtnDeconnexion = document.getElementById('btnDeconnexion');

if (modeAdmin === 'local') {
  document.getElementById('blocLocal').hidden = false;
  elBtnDossier.hidden = false;
} else if (modeAdmin === 'distant' && BACKENDS_DISTANTS[paramsUrl.get('backend')]) {
  demarrerModeDistant(paramsUrl.get('backend'));
} else {
  location.replace('../index.html'); // aucun mode valide : retour à l'accueil
}

function demarrerModeDistant(backend) {
  const api = new ApiDistante(backend);
  const nomBackend = backend === 'php' ? 'PHP' : 'ASP.NET Core';
  document.getElementById('nomBackend').textContent = nomBackend;
  document.getElementById('blocDistant').hidden = false;

  api.surSessionExpiree = () => {
    toast('Session expirée : reconnecte-toi.');
    setTimeout(() => location.reload(), 1200);
  };

  function ouvrirSession() {
    state.root = api.racine();
    elChemin.textContent = `Serveur distant (${nomBackend})`;
    elAccueil.hidden = true;
    elLayout.hidden = false;
    elBtnDeconnexion.hidden = false;
    rafraichirNiveaux().catch((e) => {
      console.error('[MegabacAdmin] Chargement des niveaux impossible :', e);
      elLayout.hidden = true;
      elAccueil.hidden = false;
      elBtnDeconnexion.hidden = true;
      document.getElementById('erreurConnexion').textContent =
        `Connecté, mais impossible de charger les données : ${e.message}`;
    });
  }

  elBtnDeconnexion.addEventListener('click', async () => {
    try { await api.deconnexion(); } catch { /* session déjà perdue */ }
    location.reload();
  });

  const form = document.getElementById('formConnexion');
  const erreur = document.getElementById('erreurConnexion');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    erreur.textContent = '';
    const bouton = document.getElementById('btnConnexion');
    bouton.disabled = true;
    try {
      await api.connexion(
        document.getElementById('fUtilisateur').value.trim(),
        document.getElementById('fMotDePasse').value
      );
      document.getElementById('fMotDePasse').value = '';
      ouvrirSession();
    } catch (err) {
      erreur.textContent = err.message;
    } finally {
      bouton.disabled = false;
    }
  });

  // Session déjà ouverte (cookie encore valide) : on entre directement.
  api.session().then((ouverte) => { if (ouverte) ouvrirSession(); });
}

elBtnDossier.addEventListener('click', async () => {
if (!window.showDirectoryPicker) {
  toast("Ton navigateur ne supporte pas cette fonctionnalité — utilise Edge ou Chrome.");
  return;
}
try {
  state.root = await window.showDirectoryPicker();
} catch {
  return; // annulé par l'utilisateur
}
elChemin.textContent = state.root.name;
elAccueil.hidden = true;
elLayout.hidden = false;
await rafraichirNiveaux();
});

async function rafraichirNiveaux() {
const noms = await listerSousDossiers(state.root);
state.niveaux = noms.filter((n) => /^[0-9]+$/.test(n)).sort((a, b) => Number(b) - Number(a));
if (state.niveauCourant && !state.niveaux.includes(state.niveauCourant)) {
  state.niveauCourant = null;
}
renderSidebar();
renderMain();
}

// ============================================================================
// Sidebar : liste des niveaux + matières du niveau sélectionné
// ============================================================================
function renderSidebar() {
const codesLibres = NIVEAUX_CATALOGUE.filter((n) => !state.niveaux.includes(n.code));

elSidebar.innerHTML = `
  <div class="bloc">
    <h2>Niveaux</h2>
    ${state.niveaux.length === 0 ? '<p class="vide">Aucun niveau pour le moment.</p>' : ''}
    ${state.niveaux.map((code) => `
      <div class="item-liste ${code === state.niveauCourant ? 'actif' : ''}" data-niveau="${code}">
        <span>${echap(libelleNiveau(code))}</span>
        <span>
          <span class="version">v${code === state.niveauCourant ? state.niveauVersion : '…'}</span>
          <button class="discret" data-supprimer-niveau="${code}" title="Supprimer ce niveau" style="color:inherit">✕</button>
        </span>
      </div>`).join('')}
    ${codesLibres.length > 0 ? `
      <div style="margin-top:10px">
        <select id="selNouveauNiveau">
          ${codesLibres.map((n) => `<option value="${n.code}">${echap(n.libelle)}</option>`).join('')}
        </select>
        <button id="btnAjouterNiveau" style="margin-top:6px;width:100%">+ Ajouter ce niveau</button>
      </div>` : ''}
  </div>
  ${state.niveauCourant ? `
    <div class="bloc">
      <h2>Matières — ${echap(libelleNiveau(state.niveauCourant))}</h2>
      ${state.matieres.length === 0 ? '<p class="vide">Aucune matière.</p>' : ''}
      ${state.matieres.map((m) => `
        <div class="item-liste ${m.id === state.matiereCourante ? 'actif' : ''}" data-matiere="${m.id}">
          <span>${m.icone || '📘'} ${echap(m.nom)}</span>
        </div>`).join('')}
      <button id="btnAjouterMatiere" style="margin-top:8px;width:100%">+ Ajouter une matière</button>
    </div>` : ''}
`;

elSidebar.querySelectorAll('[data-niveau]').forEach((el) => {
  el.addEventListener('click', () => selectionnerNiveau(el.dataset.niveau));
});
elSidebar.querySelectorAll('[data-supprimer-niveau]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    supprimerNiveau(el.dataset.supprimerNiveau);
  });
});
const btnAjouterNiveau = document.getElementById('btnAjouterNiveau');
if (btnAjouterNiveau) btnAjouterNiveau.addEventListener('click', ajouterNiveau);

elSidebar.querySelectorAll('[data-matiere]').forEach((el) => {
  el.addEventListener('click', () => selectionnerMatiere(el.dataset.matiere));
});
const btnAjouterMatiere = document.getElementById('btnAjouterMatiere');
if (btnAjouterMatiere) btnAjouterMatiere.addEventListener('click', () => ouvrirFormMatiere(null));
}

async function ajouterNiveau() {
const code = document.getElementById('selNouveauNiveau').value;
const dir = await getOrCreateDir(state.root, code);
await writeJson(dir, 'version.json', { version: 1 });
await writeJson(dir, 'matieres.json', []);
await getOrCreateDir(dir, 'matieres');
await getOrCreateDir(dir, 'cours');
await getOrCreateDir(dir, 'cours-detail');
await getOrCreateDir(dir, 'exercices');
await getOrCreateDir(dir, 'exercices-detail');
await getOrCreateDir(dir, 'epreuves');
await getOrCreateDir(dir, 'epreuves-detail');
toast(`Niveau ${libelleNiveau(code)} créé.`);
await rafraichirNiveaux();
await selectionnerNiveau(code);
}

async function selectionnerNiveau(code) {
state.niveauCourant = code;
state.matiereCourante = null;
state.niveauDir = await getOrCreateDir(state.root, code);
const v = await readJson(state.niveauDir, 'version.json', { version: 1 });
state.niveauVersion = v.version;
state.matieres = await readJson(state.niveauDir, 'matieres.json', []);
renderSidebar();
renderMain();
}

async function selectionnerMatiere(id) {
state.matiereCourante = id;
state.ongletMatiere = 'cours';
renderSidebar();
await renderMain();
}

// ============================================================================
// Panneau principal — routage simple selon l'état
// ============================================================================
async function renderMain() {
if (!state.niveauCourant) {
  elMain.innerHTML = `<p class="vide">Sélectionne ou crée un niveau à gauche pour commencer.</p>`;
  return;
}
if (!state.matiereCourante) {
  elMain.innerHTML = `<p class="vide">Sélectionne une matière à gauche, ou crée-en une nouvelle.</p>`;
  return;
}
await renderMatiereDetail();
}

// ---------------------------------------------------------------------------
// Formulaire matière (création / édition)
// ---------------------------------------------------------------------------
function ouvrirFormMatiere(matiere) {
const estEdition = !!matiere;
elMain.innerHTML = `
  <div class="carte" style="max-width:480px">
    <h3>${estEdition ? 'Modifier la matière' : 'Nouvelle matière'}</h3>
    <div class="champ">
      <label>Identifiant (slug, non modifiable après création)</label>
      <input id="fId" value="${estEdition ? echap(matiere.id) : ''}" ${estEdition ? 'disabled' : ''} placeholder="ex: maths" />
      <small>Lettres minuscules, chiffres, tirets uniquement.</small>
    </div>
    <div class="champ">
      <label>Nom affiché</label>
      <input id="fNom" value="${estEdition ? echap(matiere.nom) : ''}" placeholder="ex: Mathématiques" />
    </div>
    <div class="champ">
      <label>Icône (emoji)</label>
      <input id="fIcone" value="${estEdition ? echap(matiere.icone || '') : ''}" placeholder="📐" />
    </div>
    <div id="fErreur" class="badge-erreur"></div>
    <div style="margin-top:10px;display:flex;gap:8px">
      <button class="primaire" id="btnValider">Enregistrer</button>
      <button id="btnAnnuler">Annuler</button>
    </div>
  </div>`;

document.getElementById('btnAnnuler').addEventListener('click', renderMain);
document.getElementById('btnValider').addEventListener('click', async () => {
  const id = document.getElementById('fId').value.trim();
  const nom = document.getElementById('fNom').value.trim();
  const icone = document.getElementById('fIcone').value.trim();
  const erreurEl = document.getElementById('fErreur');

  if (!estEdition) {
    if (!/^[a-z0-9-]+$/.test(id)) { erreurEl.textContent = 'Identifiant invalide.'; return; }
    if (state.matieres.some((m) => m.id === id)) { erreurEl.textContent = 'Cet identifiant existe déjà.'; return; }
  }
  if (!nom) { erreurEl.textContent = 'Le nom est obligatoire.'; return; }

  if (estEdition) {
    matiere.nom = nom;
    matiere.icone = icone;
  } else {
    state.matieres.push({ id, nom, icone });
    const matDir = await getOrCreateDir(state.niveauDir, 'matieres');
    const dirMatiere = await getOrCreateDir(matDir, id);
    await writeJson(dirMatiere, 'version.json', { version: 1 });
    const coursDir = await getOrCreateDir(state.niveauDir, 'cours');
    await writeJson(coursDir, `${id}.json`, []);
    const exercicesDir = await getOrCreateDir(state.niveauDir, 'exercices');
    await writeJson(exercicesDir, `${id}.json`, []);
    const epreuvesDir = await getOrCreateDir(state.niveauDir, 'epreuves');
    await writeJson(epreuvesDir, `${id}.json`, []);
  }

  await writeJson(state.niveauDir, 'matieres.json', state.matieres);
  state.niveauVersion = await bumpVersion(state.niveauDir);
  toast(estEdition ? 'Matière modifiée.' : 'Matière créée.');
  state.matiereCourante = id;
  renderSidebar();
  await renderMain();
});
}

async function supprimerMatiere(matiere) {
const ok = confirm(`Supprimer « ${matiere.nom} » et tout son contenu (cours, exercices, épreuves) ? Cette action est irréversible.`);
if (!ok) return;

// Nettoyage des fichiers de détail associés, avant de supprimer les listes.
const coursDir = await getOrCreateDir(state.niveauDir, 'cours');
const coursDetailDir = await getOrCreateDir(state.niveauDir, 'cours-detail');
const coursListe = await readJson(coursDir, `${matiere.id}.json`, []);
for (const c of coursListe) await removeEntrySilencieux(coursDetailDir, `${c.id}.json`);

const exercicesDir = await getOrCreateDir(state.niveauDir, 'exercices');
const exercicesDetailDir = await getOrCreateDir(state.niveauDir, 'exercices-detail');
const exercicesListe = await readJson(exercicesDir, `${matiere.id}.json`, []);
for (const e of exercicesListe) await removeEntrySilencieux(exercicesDetailDir, `${e.id}.json`);

const epreuvesDir = await getOrCreateDir(state.niveauDir, 'epreuves');
const epreuvesDetailDir = await getOrCreateDir(state.niveauDir, 'epreuves-detail');
const epreuvesListe = await readJson(epreuvesDir, `${matiere.id}.json`, []);
for (const ep of epreuvesListe) await removeEntrySilencieux(epreuvesDetailDir, `${ep.id}.json`);

await removeEntrySilencieux(coursDir, `${matiere.id}.json`);
await removeEntrySilencieux(exercicesDir, `${matiere.id}.json`);
await removeEntrySilencieux(epreuvesDir, `${matiere.id}.json`);
const matDir = await getOrCreateDir(state.niveauDir, 'matieres');
await removeEntrySilencieux(matDir, matiere.id, { recursive: true });

state.matieres = state.matieres.filter((m) => m.id !== matiere.id);
await writeJson(state.niveauDir, 'matieres.json', state.matieres);
state.niveauVersion = await bumpVersion(state.niveauDir);

if (state.matiereCourante === matiere.id) state.matiereCourante = null;
toast('Matière supprimée.');
renderSidebar();
await renderMain();
}

async function supprimerNiveau(code) {
const ok = confirm(`Supprimer le niveau ${libelleNiveau(code)} et tout son contenu ? Cette action est irréversible.`);
if (!ok) return;
await removeEntrySilencieux(state.root, code, { recursive: true });
if (state.niveauCourant === code) { state.niveauCourant = null; state.matiereCourante = null; }
toast('Niveau supprimé.');
await rafraichirNiveaux();
}

// ---------------------------------------------------------------------------
// Détail d'une matière : onglets Cours / Exercices / Épreuves
// ---------------------------------------------------------------------------
async function renderMatiereDetail() {
const matiere = state.matieres.find((m) => m.id === state.matiereCourante);
if (!matiere) { state.matiereCourante = null; return renderMain(); }

elMain.innerHTML = `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
    <h2 style="margin:0">${matiere.icone || '📘'} ${echap(matiere.nom)}</h2>
    <div>
      <button id="btnEditerMatiere">Modifier</button>
      <button class="danger" id="btnSupprimerMatiere">Supprimer la matière</button>
    </div>
  </div>
  <div class="onglets">
    <button class="onglet ${state.ongletMatiere === 'cours' ? 'actif' : ''}" data-onglet="cours">Cours</button>
    <button class="onglet ${state.ongletMatiere === 'exercices' ? 'actif' : ''}" data-onglet="exercices">Exercices</button>
    <button class="onglet ${state.ongletMatiere === 'epreuves' ? 'actif' : ''}" data-onglet="epreuves">Épreuves</button>
  </div>
  <div id="contenuOnglet"></div>
`;

document.getElementById('btnEditerMatiere').addEventListener('click', () => ouvrirFormMatiere(matiere));
document.getElementById('btnSupprimerMatiere').addEventListener('click', () => supprimerMatiere(matiere));
elMain.querySelectorAll('[data-onglet]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    state.ongletMatiere = btn.dataset.onglet;
    await renderMatiereDetail();
  });
});

const conteneur = document.getElementById('contenuOnglet');
if (state.ongletMatiere === 'cours') await renderOngletCours(conteneur, matiere);
if (state.ongletMatiere === 'exercices') await renderOngletExercices(conteneur, matiere);
if (state.ongletMatiere === 'epreuves') await renderOngletEpreuves(conteneur, matiere);
}

// ---------------------------------------------------------------------------
// Onglet Cours
// ---------------------------------------------------------------------------
async function renderOngletCours(conteneur, matiere) {
const coursDir = await getOrCreateDir(state.niveauDir, 'cours');
const liste = await readJson(coursDir, `${matiere.id}.json`, []);

conteneur.innerHTML = `
  <div class="carte">
    <h3>Cours <button class="primaire" id="btnAjouterCours" style="float:right">+ Ajouter un cours</button></h3>
    ${liste.length === 0 ? '<p class="vide">Aucun cours.</p>' : `
      <table><thead><tr><th>Titre</th><th>Résumé</th><th></th></tr></thead><tbody>
        ${liste.map((c) => `
          <tr>
            <td>${echap(c.titre)}</td>
            <td>${echap(c.resume || '')}</td>
            <td class="actions">
              <button data-editer="${c.id}">Modifier</button>
              <button class="danger" data-supprimer="${c.id}">Supprimer</button>
            </td>
          </tr>`).join('')}
      </tbody></table>`}
  </div>`;

conteneur.querySelector('#btnAjouterCours').addEventListener('click', () => ouvrirFormCours(matiere, null, liste));
conteneur.querySelectorAll('[data-editer]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const item = liste.find((c) => c.id === btn.dataset.editer);
    const coursDetailDir = await getOrCreateDir(state.niveauDir, 'cours-detail');
    const detail = await readJson(coursDetailDir, `${item.id}.json`, { contenu: '' });
    ouvrirFormCours(matiere, { ...item, contenu: detail.contenu }, liste);
  });
});
conteneur.querySelectorAll('[data-supprimer]').forEach((btn) => {
  btn.addEventListener('click', () => supprimerCours(matiere, btn.dataset.supprimer, liste));
});
}

function ouvrirFormCours(matiere, cours, liste) {
const estEdition = !!cours;
elMain.innerHTML = `
  <div class="editeur-avec-apercu">
    <div class="editeur-col">
      <div class="carte" style="flex-shrink:0">
        <h3>${estEdition ? 'Modifier le cours' : 'Nouveau cours'}</h3>
        <div class="champ"><label>Titre</label><input id="fTitre" value="${estEdition ? echap(cours.titre) : ''}" /></div>
        <div class="champ"><label>Résumé (affiché dans la liste)</label><input id="fResume" value="${estEdition ? echap(cours.resume || '') : ''}" /></div>
        <div class="champ">
          <label>Contenu (HTML simple : h2, p, ul/li, strong, em)</label>
          <textarea data-image id="fContenu" style="min-height:180px">${estEdition ? echap(cours.contenu || '') : ''}</textarea>
        </div>
        <div style="display:flex;gap:8px">
          <button class="primaire" id="btnValider">Enregistrer</button>
          <button id="btnAnnuler">Annuler</button>
        </div>
      </div>
    </div>
    <div class="apercu-col">
      <div class="apercu-header">Aperçu</div>
      <div class="apercu-contenu" id="apercuCours">
        <div class="apercu-vide">L'aperçu s'affichera ici…</div>
      </div>
    </div>
  </div>`;

activerImportImage(elMain);
const inputTitre = document.getElementById('fTitre');
const inputResume = document.getElementById('fResume');
const textareaContenu = document.getElementById('fContenu');
const apercuCours = document.getElementById('apercuCours');

function mettreAJourApercu() {
  const titre = inputTitre.value.trim();
  const contenu = textareaContenu.value.trim();
  if (!titre && !contenu) {
    apercuCours.innerHTML = '<div class="apercu-vide">L\'aperçu s\'affichera ici…</div>';
    return;
  }
  apercuCours.innerHTML = `
    ${titre ? `<h2>${echap(titre)}</h2>` : ''}
    ${contenu ? contenu : ''}`;
}

inputTitre.addEventListener('input', mettreAJourApercu);
textareaContenu.addEventListener('input', mettreAJourApercu);
mettreAJourApercu();

document.getElementById('btnAnnuler').addEventListener('click', () => renderMatiereDetail());
document.getElementById('btnValider').addEventListener('click', async () => {
  const titre = document.getElementById('fTitre').value.trim();
  const resume = document.getElementById('fResume').value.trim();
  const contenu = document.getElementById('fContenu').value;
  if (!titre) { toast('Le titre est obligatoire.'); return; }

  const id = estEdition ? cours.id : genererId(`${matiere.id}-c`);
  const coursDir = await getOrCreateDir(state.niveauDir, 'cours');
  const coursDetailDir = await getOrCreateDir(state.niveauDir, 'cours-detail');

  if (estEdition) {
    const item = liste.find((c) => c.id === id);
    item.titre = titre; item.resume = resume;
  } else {
    liste.push({ id, titre, resume });
  }
  await writeJson(coursDir, `${matiere.id}.json`, liste);
  await writeJson(coursDetailDir, `${id}.json`, { id, titre, contenu });

  const matDir = await getOrCreateDir(state.niveauDir, 'matieres');
  const dirMatiere = await getOrCreateDir(matDir, matiere.id);
  await bumpVersion(dirMatiere);

  toast(estEdition ? 'Cours modifié.' : 'Cours créé.');
  await renderMatiereDetail();
});
}

async function supprimerCours(matiere, id, liste) {
if (!confirm('Supprimer ce cours ?')) return;
const coursDir = await getOrCreateDir(state.niveauDir, 'cours');
const coursDetailDir = await getOrCreateDir(state.niveauDir, 'cours-detail');
const nouvelleListe = liste.filter((c) => c.id !== id);
await writeJson(coursDir, `${matiere.id}.json`, nouvelleListe);
await removeEntrySilencieux(coursDetailDir, `${id}.json`);
const matDir = await getOrCreateDir(state.niveauDir, 'matieres');
const dirMatiere = await getOrCreateDir(matDir, matiere.id);
await bumpVersion(dirMatiere);
toast('Cours supprimé.');
await renderMatiereDetail();
}

// ---------------------------------------------------------------------------
// Onglet Exercices
// ---------------------------------------------------------------------------
async function renderOngletExercices(conteneur, matiere) {
const dir = await getOrCreateDir(state.niveauDir, 'exercices');
const liste = await readJson(dir, `${matiere.id}.json`, []);

conteneur.innerHTML = `
  <div class="carte">
    <h3>Exercices <button class="primaire" id="btnAjouter" style="float:right">+ Ajouter un exercice</button></h3>
    ${liste.length === 0 ? '<p class="vide">Aucun exercice.</p>' : `
      <table><thead><tr><th>Titre</th><th>Difficulté</th><th></th></tr></thead><tbody>
        ${liste.map((e) => `
          <tr>
            <td>${echap(e.titre)}</td>
            <td>${echap(e.difficulte || '')}</td>
            <td class="actions">
              <button data-editer="${e.id}">Modifier</button>
              <button class="danger" data-supprimer="${e.id}">Supprimer</button>
            </td>
          </tr>`).join('')}
      </tbody></table>`}
  </div>`;

conteneur.querySelector('#btnAjouter').addEventListener('click', () => ouvrirFormExercice(matiere, null, liste));
conteneur.querySelectorAll('[data-editer]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const item = liste.find((e) => e.id === btn.dataset.editer);
    const detailDir = await getOrCreateDir(state.niveauDir, 'exercices-detail');
    const detail = await readJson(detailDir, `${item.id}.json`, {});
    ouvrirFormExercice(matiere, { ...item, ...detail }, liste);
  });
});
conteneur.querySelectorAll('[data-supprimer]').forEach((btn) => {
  btn.addEventListener('click', () => supprimerExercice(matiere, btn.dataset.supprimer, liste));
});
}

function renderChoixEditeur(choix, reponseCorrecte) {
return choix.map((c, i) => `
  <div class="choix-ligne" data-choix-index="${i}">
    <input type="radio" name="reponseCorrecte" value="${i}" ${i === reponseCorrecte ? 'checked' : ''} title="Bonne réponse" />
    <input type="text" class="valeur-choix" value="${echap(c)}" placeholder="Choix ${i + 1}" />
    <button type="button" class="discret" data-retirer-choix="${i}">✕</button>
  </div>`).join('');
}

function ouvrirFormExercice(matiere, exercice, liste) {
const estEdition = !!exercice;
let type = estEdition ? exercice.type : 'qcm';
let choix = estEdition && exercice.choix ? [...exercice.choix] : ['', ''];
let reponseCorrecte = estEdition ? (exercice.reponseCorrecte ?? 0) : 0;

function rendreFormulaire() {
  elMain.innerHTML = `
    <div class="editeur-avec-apercu">
      <div class="editeur-col">
        <div class="carte" style="flex-shrink:0">
          <h3>${estEdition ? "Modifier l'exercice" : 'Nouvel exercice'}</h3>
          <div class="champ"><label>Titre (affiché dans la liste)</label><input id="fTitre" value="${estEdition ? echap(exercice.titre) : ''}" /></div>
          <div class="ligne">
            <div class="champ">
              <label>Difficulté</label>
              <select id="fDifficulte">
                ${['Facile', 'Moyen', 'Difficile'].map((d) => `<option ${estEdition && exercice.difficulte === d ? 'selected' : ''}>${d}</option>`).join('')}
              </select>
            </div>
            <div class="champ">
              <label>Type</label>
              <select id="fType">
                <option value="qcm" ${type === 'qcm' ? 'selected' : ''}>QCM</option>
                <option value="texte" ${type === 'texte' ? 'selected' : ''}>Question ouverte</option>
              </select>
            </div>
          </div>
          <div class="champ"><label>Question</label><textarea data-image id="fQuestion" style="min-height:100px">${estEdition ? echap(exercice.question || '') : ''}</textarea></div>
          <div id="zoneChoix"></div>
          <div class="champ"><label>Explication (correction affichée à l'élève)</label><textarea data-image id="fExplication" style="min-height:80px">${estEdition ? echap(exercice.explication || '') : ''}</textarea></div>
          <div style="display:flex;gap:8px">
            <button class="primaire" id="btnValider">Enregistrer</button>
            <button id="btnAnnuler">Annuler</button>
          </div>
        </div>
      </div>
      <div class="apercu-col">
        <div class="apercu-header">Aperçu</div>
        <div class="apercu-contenu" id="apercuExercice">
          <div class="apercu-vide">L'aperçu s'affichera ici…</div>
        </div>
      </div>
    </div>`;

  activerImportImage(elMain);
  const zoneChoix = document.getElementById('zoneChoix');
  const apercuExercice = document.getElementById('apercuExercice');

  function mettreAJourApercuExercice() {
    const question = document.getElementById('fQuestion').value.trim();
    const explication = document.getElementById('fExplication').value.trim();
    if (!question) {
      apercuExercice.innerHTML = '<div class="apercu-vide">L\'aperçu s\'affichera ici…</div>';
      return;
    }
    let html = `<h3>Question</h3><p>${echapAvecImages(question)}</p>`;
    if (type === 'qcm') {
      if (choix.some((c) => c.trim())) {
        html += `<h3>Réponses</h3><ul>`;
        choix.forEach((c, i) => {
          if (!c.trim()) return;
          const estBonne = i === reponseCorrecte ? ' ✓ <strong>(bonne)</strong>' : '';
          html += `<li>${echap(c)}${estBonne}</li>`;
        });
        html += `</ul>`;
      }
    }
    if (explication) {
      html += `<h3>Correction</h3><p>${echapAvecImages(explication)}</p>`;
    }
    apercuExercice.innerHTML = html;
  }

  function rendreChoix() {
    if (type !== 'qcm') { zoneChoix.innerHTML = ''; return; }
    zoneChoix.innerHTML = `
      <div class="champ">
        <label>Choix (coche la bonne réponse)</label>
        ${renderChoixEditeur(choix, reponseCorrecte)}
        <button type="button" id="btnAjouterChoix" style="margin-top:4px">+ Ajouter un choix</button>
      </div>`;
    zoneChoix.querySelectorAll('.valeur-choix').forEach((input, i) => {
      input.addEventListener('input', () => { choix[i] = input.value; mettreAJourApercuExercice(); });
    });
    zoneChoix.querySelectorAll('[name="reponseCorrecte"]').forEach((radio) => {
      radio.addEventListener('change', () => { reponseCorrecte = Number(radio.value); mettreAJourApercuExercice(); });
    });
    zoneChoix.querySelectorAll('[data-retirer-choix]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.retirerChoix);
        choix.splice(i, 1);
        if (reponseCorrecte >= choix.length) reponseCorrecte = 0;
        rendreChoix();
        mettreAJourApercuExercice();
      });
    });
    document.getElementById('btnAjouterChoix').addEventListener('click', () => {
      choix.push('');
      rendreChoix();
    });
  }
  rendreChoix();
  mettreAJourApercuExercice();

  document.getElementById('fQuestion').addEventListener('input', mettreAJourApercuExercice);
  document.getElementById('fExplication').addEventListener('input', mettreAJourApercuExercice);
  document.getElementById('fType').addEventListener('change', (e) => {
    type = e.target.value;
    rendreChoix();
    mettreAJourApercuExercice();
  });
  document.getElementById('btnAnnuler').addEventListener('click', () => renderMatiereDetail());
  document.getElementById('btnValider').addEventListener('click', async () => {
    const titre = document.getElementById('fTitre').value.trim();
    const difficulte = document.getElementById('fDifficulte').value;
    const question = document.getElementById('fQuestion').value.trim();
    const explication = document.getElementById('fExplication').value.trim();
    if (!titre || !question) { toast('Titre et question sont obligatoires.'); return; }
    if (type === 'qcm' && choix.filter((c) => c.trim()).length < 2) { toast('Au moins 2 choix sont nécessaires pour un QCM.'); return; }

    const id = estEdition ? exercice.id : genererId(`${matiere.id}-e`);
    const dirListe = await getOrCreateDir(state.niveauDir, 'exercices');
    const dirDetail = await getOrCreateDir(state.niveauDir, 'exercices-detail');

    if (estEdition) {
      const item = liste.find((e) => e.id === id);
      item.titre = titre; item.difficulte = difficulte;
    } else {
      liste.push({ id, titre, difficulte });
    }
    await writeJson(dirListe, `${matiere.id}.json`, liste);

    const detail = { id, type, question, explication };
    if (type === 'qcm') { detail.choix = choix; detail.reponseCorrecte = reponseCorrecte; }
    await writeJson(dirDetail, `${id}.json`, detail);

    const matDir = await getOrCreateDir(state.niveauDir, 'matieres');
    const dirMatiere = await getOrCreateDir(matDir, matiere.id);
    await bumpVersion(dirMatiere);

    toast(estEdition ? 'Exercice modifié.' : 'Exercice créé.');
    await renderMatiereDetail();
  });
}

rendreFormulaire();
}

async function supprimerExercice(matiere, id, liste) {
if (!confirm('Supprimer cet exercice ?')) return;
const dirListe = await getOrCreateDir(state.niveauDir, 'exercices');
const dirDetail = await getOrCreateDir(state.niveauDir, 'exercices-detail');
const nouvelleListe = liste.filter((e) => e.id !== id);
await writeJson(dirListe, `${matiere.id}.json`, nouvelleListe);
await removeEntrySilencieux(dirDetail, `${id}.json`);
const matDir = await getOrCreateDir(state.niveauDir, 'matieres');
const dirMatiere = await getOrCreateDir(matDir, matiere.id);
await bumpVersion(dirMatiere);
toast('Exercice supprimé.');
await renderMatiereDetail();
}

// ---------------------------------------------------------------------------
// Onglet Épreuves
// ---------------------------------------------------------------------------
async function renderOngletEpreuves(conteneur, matiere) {
const dir = await getOrCreateDir(state.niveauDir, 'epreuves');
const liste = await readJson(dir, `${matiere.id}.json`, []);

conteneur.innerHTML = `
  <div class="carte">
    <h3>Épreuves <button class="primaire" id="btnAjouter" style="float:right">+ Ajouter une épreuve</button></h3>
    ${liste.length === 0 ? '<p class="vide">Aucune épreuve.</p>' : `
      <table><thead><tr><th>Titre</th><th>Durée</th><th>Questions</th><th></th></tr></thead><tbody>
        ${liste.map((ep) => `
          <tr>
            <td>${echap(ep.titre)}</td>
            <td>${ep.dureeMinutes} min</td>
            <td>${ep.nbQuestions}</td>
            <td class="actions">
              <button data-editer="${ep.id}">Modifier</button>
              <button class="danger" data-supprimer="${ep.id}">Supprimer</button>
            </td>
          </tr>`).join('')}
      </tbody></table>`}
  </div>`;

conteneur.querySelector('#btnAjouter').addEventListener('click', () => ouvrirFormEpreuve(matiere, null, liste));
conteneur.querySelectorAll('[data-editer]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const item = liste.find((ep) => ep.id === btn.dataset.editer);
    const detailDir = await getOrCreateDir(state.niveauDir, 'epreuves-detail');
    const detail = await readJson(detailDir, `${item.id}.json`, { questions: [] });
    ouvrirFormEpreuve(matiere, { ...item, ...detail }, liste);
  });
});
conteneur.querySelectorAll('[data-supprimer]').forEach((btn) => {
  btn.addEventListener('click', () => supprimerEpreuve(matiere, btn.dataset.supprimer, liste));
});
}

function ouvrirFormEpreuve(matiere, epreuve, liste) {
const estEdition = !!epreuve;
let questions = estEdition ? epreuve.questions.map((q) => ({ ...q, choix: q.choix ? [...q.choix] : undefined })) : [];

function rendreFormulaire() {
  elMain.innerHTML = `
    <div class="editeur-avec-apercu">
      <div class="editeur-col">
        <div class="carte" style="flex-shrink:0">
          <h3>${estEdition ? "Modifier l'épreuve" : 'Nouvelle épreuve'}</h3>
          <div class="ligne">
            <div class="champ"><label>Titre</label><input id="fTitre" value="${estEdition ? echap(epreuve.titre) : ''}" /></div>
            <div class="champ"><label>Durée (minutes)</label><input id="fDuree" type="number" min="1" value="${estEdition ? epreuve.dureeMinutes : 20}" /></div>
            <div class="champ"><label>Barème</label><input id="fBareme" type="number" min="1" value="${estEdition ? (epreuve.bareme || 20) : 20}" /></div>
          </div>
          <div class="champ">
            <label>Questions</label>
            <div id="zoneQuestions"></div>
            <button type="button" id="btnAjouterQuestion">+ Ajouter une question</button>
          </div>
          <div id="fErreur" class="badge-erreur"></div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="primaire" id="btnValider">Enregistrer</button>
            <button id="btnAnnuler">Annuler</button>
          </div>
        </div>
      </div>
      <div class="apercu-col">
        <div class="apercu-header">Aperçu de l'épreuve</div>
        <div class="apercu-contenu" id="apercuEpreuve">
          <div class="apercu-vide">L'aperçu s'affichera ici…</div>
        </div>
      </div>
    </div>`;

  const zoneQuestions = document.getElementById('zoneQuestions');
  const apercuEpreuve = document.getElementById('apercuEpreuve');

  function mettreAJourApercuEpreuve() {
    const titre = document.getElementById('fTitre').value.trim();
    const duree = document.getElementById('fDuree').value;
    const bareme = document.getElementById('fBareme').value;
    const questionsValides = questions.filter((q) => q.enonce && q.enonce.trim());
    if (!titre && questionsValides.length === 0) {
      apercuEpreuve.innerHTML = '<div class="apercu-vide">L\'aperçu s\'affichera ici…</div>';
      return;
    }
    let html = '';
    if (titre) html += `<h2>${echap(titre)}</h2>`;
    if (duree || bareme) html += `<p><strong>Infos :</strong> ${duree} min • Barème: ${bareme}</p>`;
    questionsValides.forEach((q, i) => {
      html += `<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">`;
      html += `<h3>Q${i + 1}. ${echapAvecImages(q.enonce)}</h3>`;
      if (q.type === 'qcm' && q.choix && q.choix.length > 0) {
        html += `<ul>`;
        q.choix.forEach((c, ci) => {
          if (c.trim()) {
            const estBonne = ci === (q.reponseCorrecte ?? 0) ? ' ✓ <strong>(bonne)</strong>' : '';
            html += `<li>${echap(c)}${estBonne}</li>`;
          }
        });
        html += `</ul>`;
      }
      if (q.explication && q.explication.trim()) {
        html += `<p><em>Correction : ${echapAvecImages(q.explication)}</em></p>`;
      }
      html += `</div>`;
    });
    apercuEpreuve.innerHTML = html || '<div class="apercu-vide">L\'aperçu s\'affichera ici…</div>';
  }

  function rendreQuestions() {
    zoneQuestions.innerHTML = questions.length === 0
      ? '<p class="vide">Aucune question — ajoutes-en au moins une.</p>'
      : questions.map((q, i) => `
        <div class="question-editeur" data-question-index="${i}">
          <div class="entete">
            <strong>Question ${i + 1}</strong>
            <button type="button" class="discret" data-retirer-question="${i}">✕ Retirer</button>
          </div>
          <div class="champ">
            <label>Type</label>
            <select class="q-type" data-i="${i}">
              <option value="qcm" ${q.type === 'qcm' ? 'selected' : ''}>QCM</option>
              <option value="texte" ${q.type === 'texte' ? 'selected' : ''}>Question ouverte</option>
            </select>
          </div>
          <div class="champ"><label>Énoncé</label><textarea data-image class="q-enonce" data-i="${i}">${echap(q.enonce || '')}</textarea></div>
          ${q.type === 'qcm' ? `
            <div class="champ">
              <label>Choix (coche la bonne réponse)</label>
              ${renderChoixEditeur(q.choix || ['', ''], q.reponseCorrecte ?? 0)}
              <button type="button" data-ajouter-choix-question="${i}">+ Ajouter un choix</button>
            </div>` : ''}
          <div class="champ"><label>Explication</label><textarea data-image class="q-explication" data-i="${i}">${echap(q.explication || '')}</textarea></div>
        </div>`).join('');

    activerImportImage(zoneQuestions);
    // Câblage des champs simples
    zoneQuestions.querySelectorAll('.q-type').forEach((sel) => {
      sel.addEventListener('change', () => {
        const i = Number(sel.dataset.i);
        questions[i].type = sel.value;
        if (sel.value === 'qcm' && !questions[i].choix) { questions[i].choix = ['', '']; questions[i].reponseCorrecte = 0; }
        rendreQuestions();
        mettreAJourApercuEpreuve();
      });
    });
    zoneQuestions.querySelectorAll('.q-enonce').forEach((ta) => {
      ta.addEventListener('input', () => { questions[Number(ta.dataset.i)].enonce = ta.value; mettreAJourApercuEpreuve(); });
    });
    zoneQuestions.querySelectorAll('.q-explication').forEach((ta) => {
      ta.addEventListener('input', () => { questions[Number(ta.dataset.i)].explication = ta.value; mettreAJourApercuEpreuve(); });
    });
    zoneQuestions.querySelectorAll('[data-retirer-question]').forEach((btn) => {
      btn.addEventListener('click', () => { questions.splice(Number(btn.dataset.retirerQuestion), 1); rendreQuestions(); mettreAJourApercuEpreuve(); });
    });
    document.getElementById('btnAjouterQuestion') && document.getElementById('btnAjouterQuestion').addEventListener('click', () => {
      questions.push({ id: genererId(`${matiere.id}-q`), type: 'qcm', enonce: '', choix: ['', ''], reponseCorrecte: 0, explication: '' });
      rendreQuestions();
      mettreAJourApercuEpreuve();
    });

    // Câblage des sous-éditeurs de choix (par question)
    zoneQuestions.querySelectorAll('.question-editeur').forEach((bloc) => {
      const i = Number(bloc.dataset.questionIndex);
      bloc.querySelectorAll('.valeur-choix').forEach((input, ci) => {
        input.addEventListener('input', () => { questions[i].choix[ci] = input.value; mettreAJourApercuEpreuve(); });
      });
      bloc.querySelectorAll('[name="reponseCorrecte"]').forEach((radio) => {
        radio.addEventListener('change', () => { questions[i].reponseCorrecte = Number(radio.value); mettreAJourApercuEpreuve(); });
      });
      bloc.querySelectorAll('[data-retirer-choix]').forEach((btn) => {
        btn.addEventListener('click', () => {
          questions[i].choix.splice(Number(btn.dataset.retirerChoix), 1);
          if (questions[i].reponseCorrecte >= questions[i].choix.length) questions[i].reponseCorrecte = 0;
          rendreQuestions();
          mettreAJourApercuEpreuve();
        });
      });
      const btnAjoutChoix = bloc.querySelector(`[data-ajouter-choix-question="${i}"]`);
      if (btnAjoutChoix) btnAjoutChoix.addEventListener('click', () => { questions[i].choix.push(''); rendreQuestions(); mettreAJourApercuEpreuve(); });
    });
  }
  rendreQuestions();
  document.getElementById('fTitre').addEventListener('input', mettreAJourApercuEpreuve);
  document.getElementById('fDuree').addEventListener('input', mettreAJourApercuEpreuve);
  document.getElementById('fBareme').addEventListener('input', mettreAJourApercuEpreuve);
  mettreAJourApercuEpreuve();

  document.getElementById('btnAnnuler').addEventListener('click', () => renderMatiereDetail());
  document.getElementById('btnValider').addEventListener('click', async () => {
    const titre = document.getElementById('fTitre').value.trim();
    const dureeMinutes = Number(document.getElementById('fDuree').value);
    const bareme = Number(document.getElementById('fBareme').value);
    const erreurEl = document.getElementById('fErreur');

    if (!titre) { erreurEl.textContent = 'Le titre est obligatoire.'; return; }
    if (questions.length === 0) { erreurEl.textContent = 'Ajoute au moins une question.'; return; }
    for (const q of questions) {
      if (!q.enonce.trim()) { erreurEl.textContent = 'Chaque question doit avoir un énoncé.'; return; }
      if (q.type === 'qcm' && (!q.choix || q.choix.filter((c) => c.trim()).length < 2)) {
        erreurEl.textContent = 'Chaque QCM doit avoir au moins 2 choix.'; return;
      }
    }

    const id = estEdition ? epreuve.id : genererId(`${matiere.id}-ep`);
    const dirListe = await getOrCreateDir(state.niveauDir, 'epreuves');
    const dirDetail = await getOrCreateDir(state.niveauDir, 'epreuves-detail');

    const entreeListe = { id, titre, dureeMinutes, nbQuestions: questions.length };
    if (estEdition) {
      const idx = liste.findIndex((ep) => ep.id === id);
      liste[idx] = entreeListe;
    } else {
      liste.push(entreeListe);
    }
    await writeJson(dirListe, `${matiere.id}.json`, liste);
    await writeJson(dirDetail, `${id}.json`, { id, titre, dureeMinutes, bareme, questions });

    const matDir = await getOrCreateDir(state.niveauDir, 'matieres');
    const dirMatiere = await getOrCreateDir(matDir, matiere.id);
    await bumpVersion(dirMatiere);

    toast(estEdition ? 'Épreuve modifiée.' : 'Épreuve créée.');
    await renderMatiereDetail();
  });
}

rendreFormulaire();
}

async function supprimerEpreuve(matiere, id, liste) {
if (!confirm('Supprimer cette épreuve ?')) return;
const dirListe = await getOrCreateDir(state.niveauDir, 'epreuves');
const dirDetail = await getOrCreateDir(state.niveauDir, 'epreuves-detail');
const nouvelleListe = liste.filter((ep) => ep.id !== id);
await writeJson(dirListe, `${matiere.id}.json`, nouvelleListe);
await removeEntrySilencieux(dirDetail, `${id}.json`);
const matDir = await getOrCreateDir(state.niveauDir, 'matieres');
const dirMatiere = await getOrCreateDir(matDir, matiere.id);
await bumpVersion(dirMatiere);
toast('Épreuve supprimée.');
await renderMatiereDetail();
}
