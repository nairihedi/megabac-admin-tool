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
// ============================================================================
// Protection des modifications non enregistrées
//
// Un formulaire d'édition déclare gardeEdition = { actif(), enregistrer(), abandonner() }.
// Tant que actif() est vrai, toute sortie du formulaire passe par peutQuitter(), qui
// ouvre une fenêtre modale : Enregistrer / Quitter sans enregistrer / Continuer l'édition.
// ============================================================================
let gardeEdition = null;

function demanderSortie() {
  return new Promise((resolve) => {
    const dialogue = document.createElement('dialog');
    dialogue.className = 'modale';
    dialogue.innerHTML = `
      <h3>Modifications non enregistrées</h3>
      <p>Tu as des modifications en cours. Si tu quittes sans enregistrer, elles seront perdues.</p>
      <div class="modale-actions">
        <button type="button" data-choix="rester">Continuer l'édition</button>
        <button type="button" class="danger" data-choix="abandonner">Quitter sans enregistrer</button>
        <button type="button" class="primaire" data-choix="enregistrer">Enregistrer</button>
      </div>`;
    dialogue.addEventListener('click', (e) => {
      const bouton = e.target.closest('[data-choix]');
      if (bouton) dialogue.close(bouton.dataset.choix);
    });
    // Échap ferme le dialogue sans valeur : on reste sur le formulaire.
    dialogue.addEventListener('close', () => {
      dialogue.remove();
      resolve(dialogue.returnValue || 'rester');
    });
    document.body.appendChild(dialogue);
    dialogue.showModal();
    dialogue.querySelector('[data-choix="enregistrer"]').focus();
  });
}

// true si l'on peut quitter le formulaire en cours (rien à perdre, enregistré, ou abandon confirmé).
async function peutQuitter() {
  if (!gardeEdition || !gardeEdition.actif()) return true;
  const choix = await demanderSortie();
  if (choix === 'enregistrer') return gardeEdition.enregistrer();
  if (choix === 'abandonner') { gardeEdition.abandonner(); return true; }
  return false;
}

// Clics qui font quitter le formulaire (barre latérale, en-tête) : interceptés avant leur
// traitement, puis rejoués si la sortie est confirmée. Les boutons ▲▼ ne quittent pas le formulaire.
function protegerSortie(racine, selecteur) {
  racine.addEventListener('click', async (e) => {
    if (!gardeEdition || !gardeEdition.actif()) return;
    const cible = e.target.closest(selecteur);
    if (!cible || e.target.closest('[data-monter], [data-descendre]')) return;
    e.preventDefault();
    e.stopPropagation();
    if (await peutQuitter()) (e.target.closest('button, a') || cible).click();
  }, true);
}
protegerSortie(elSidebar, 'button, [data-niveau], [data-matiere]');
protegerSortie(document.querySelector('header'), 'button, a');

function echap(s = '') {
return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function genererId(prefixe) {
return `${prefixe}-${Math.random().toString(36).slice(2, 7)}`;
}

// Comme echap(), mais laisse passer les <img src="data:image/...;base64,..."> que l'ancien
// bouton « Insérer une image » écrivait dans les champs texte (cf. htmlDepuisChamp).
function echapAvecImages(s = '') {
return echap(s).replace(
/&lt;img src=&quot;(data:image\/[a-z+.-]+;base64,[A-Za-z0-9+\/=]+)&quot; alt=&quot;&quot;&gt;/g,
'<img src="$1" alt="">'
);
}

// ---------------------------------------------------------------------------
// Champs riches (question, énoncé, explication) : texte + variante HTML optionnelle
//
// Les données gardent toujours le champ texte (`question`, `enonce`, `explication`).
// Dès qu'il y a de la mise en forme ou une image, la variante `*_html` est ajoutée :
// c'est elle que l'application affiche en priorité.
// ---------------------------------------------------------------------------

// HTML à charger dans l'éditeur. Sans variante HTML, le texte est converti en paragraphes
// (les <img base64> insérées par l'ancien bouton « Insérer une image » sont conservées).
function htmlDepuisChamp(texte = '', html) {
if (html) return html;
return String(texte || '').split(/\n+/).filter((l) => l.trim()).map((l) => `<p>${echapAvecImages(l)}</p>`).join('');
}

// Texte brut d'un HTML produit par l'éditeur (une ligne par bloc, puces pour les listes).
function texteDepuisHtml(html = '') {
const div = document.createElement('div');
div.innerHTML = html;
return [...div.children].map((b) => (/^(UL|OL)$/.test(b.tagName)
  ? [...b.children].map((li) => `- ${li.textContent.trim()}`).join('\n')
  : b.textContent.trim())).filter(Boolean).join('\n');
}

// { texte, html } à enregistrer : html est absent pour un simple paragraphe sans mise en forme.
function champDepuisHtml(html = '') {
const div = document.createElement('div');
div.innerHTML = html;
const blocs = [...div.children];
const simple = blocs.length <= 1 && (!blocs[0] || (blocs[0].tagName === 'P' && blocs[0].children.length === 0));
const texte = texteDepuisHtml(html) || (div.querySelector('img') ? '[image]' : '');
return simple ? { texte } : { texte, html };
}

// Choix d'un QCM prêts à enregistrer : choix vides retirés, index de la bonne réponse recalé.
// Renvoie un message d'erreur (chaîne) si le QCM est incomplet.
function choixValides(choix, reponseCorrecte) {
const pleins = choix.map((c, i) => ({ c: c.trim(), i })).filter((x) => x.c);
if (pleins.length < 2) return 'Un QCM doit avoir au moins 2 choix.';
const bonne = pleins.findIndex((x) => x.i === reponseCorrecte);
if (bonne < 0) return 'La bonne réponse cochée est vide.';
return { choix: pleins.map((x) => x.c), reponseCorrecte: bonne };
}

// ---------------------------------------------------------------------------
// Formulaire d'édition : témoin « non enregistré », Ctrl+S, protection à la sortie.
//
// formulaire : élément contenant .etat-form, #btnValider et #btnAnnuler ;
// enregistrer() : écrit les données, renvoie false si la saisie est invalide (après
// avoir prévenu), lève une erreur si l'écriture échoue.
// Renvoie marquerModifie(), à appeler à chaque modification.
// ---------------------------------------------------------------------------
function installerFormulaire(formulaire, enregistrer) {
const etat = formulaire.querySelector('.etat-form');
const btnValider = formulaire.querySelector('#btnValider');
let modifie = false;
const marquerModifie = () => {
  if (modifie) return;
  modifie = true;
  etat.textContent = '● Modifications non enregistrées';
};

async function sauver() {
  btnValider.disabled = true;
  let ok = false;
  try {
    ok = await enregistrer();
  } catch (err) {
    toast('Échec de l’enregistrement : ' + (err && err.message ? err.message : err));
  }
  if (ok) modifie = false; else btnValider.disabled = false;
  return ok;
}

// Ctrl+S enregistre ; fermer l'onglet avec des modifications demande confirmation.
// Les deux écouteurs se retirent d'eux-mêmes quand le formulaire n'est plus affiché.
const surTouche = (e) => {
  if (!formulaire.isConnected) { document.removeEventListener('keydown', surTouche); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); btnValider.click(); }
};
document.addEventListener('keydown', surTouche);
const avantFermeture = (e) => {
  if (!formulaire.isConnected) { window.removeEventListener('beforeunload', avantFermeture); return; }
  if (modifie) e.preventDefault();
};
window.addEventListener('beforeunload', avantFermeture);

// Quitter le formulaire (Annuler, clic dans la barre latérale ou l'en-tête) avec des
// modifications en cours ouvre la fenêtre de confirmation (cf. peutQuitter).
gardeEdition = {
  actif: () => formulaire.isConnected && modifie,
  enregistrer: sauver,
  abandonner: () => { modifie = false; },
};
formulaire.querySelector('#btnAnnuler').addEventListener('click', async () => {
  if (await peutQuitter()) renderMatiereDetail();
});
btnValider.addEventListener('click', async () => {
  if (await sauver()) await renderMatiereDetail();
});
return marquerModifie;
}

// Barre d'actions commune aux formulaires d'édition.
function barreFormulaire(titre) {
return `
    <div class="barre-form">
      <h3>${titre}</h3>
      <span class="etat-form"></span>
      <button id="btnAnnuler">Annuler</button>
      <button class="primaire" id="btnValider" title="Ctrl+S">Enregistrer</button>
    </div>`;
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
// Réordonnancement (matières, cours, exercices, épreuves)
//
// L'ordre d'affichage dans l'application est celui du tableau dans le fichier
// de liste : réordonner = réécrire ce tableau, puis incrémenter la version
// concernée pour que l'application retélécharge la liste.
// Deux gestes : boutons ▲ ▼ (précis, tactile) ou glisser-déposer.
// Les éléments réordonnables portent data-ordre-id="<id>" et draggable="true".
// ============================================================================
function boutonsOrdre(i, n) {
return `<button class="discret ordre" data-monter title="Monter" ${i === 0 ? 'disabled' : ''} style="color:inherit">▲</button>` +
       `<button class="discret ordre" data-descendre title="Descendre" ${i === n - 1 ? 'disabled' : ''} style="color:inherit">▼</button>`;
}

// Écrit la liste (cours / exercices / epreuves) d'une matière et incrémente la version de la matière.
async function enregistrerOrdreMatiere(nomDossier, matiere, liste) {
const dir = await getOrCreateDir(state.niveauDir, nomDossier);
await writeJson(dir, `${matiere.id}.json`, liste);
const matDir = await getOrCreateDir(state.niveauDir, 'matieres');
await bumpVersion(await getOrCreateDir(matDir, matiere.id));
}

// racine : élément contenant les lignes ; liste : tableau (modifié sur place) ;
// enregistrer : écrit sur disque/serveur ; rerendre : réaffiche après enregistrement.
function activerReordonnancement(racine, liste, enregistrer, rerendre, { silencieux = false } = {}) {
const indexDe = (el) => liste.findIndex((x) => String(x.id) === el.dataset.ordreId);
let glisse = null; // id de la ligne en cours de déplacement

async function deplacer(de, vers) {
  if (de < 0 || vers < 0 || vers >= liste.length || de === vers) return;
  const [element] = liste.splice(de, 1);
  liste.splice(vers, 0, element);
  try {
    await enregistrer();
    if (!silencieux) toast('Ordre enregistré.');
  } catch (err) {
    toast('Échec de l’enregistrement de l’ordre : ' + (err && err.message ? err.message : err));
  }
  await rerendre();
}

const nettoyer = () => racine.querySelectorAll('.depot-avant, .depot-apres, .glisse')
  .forEach((e) => e.classList.remove('depot-avant', 'depot-apres', 'glisse'));

racine.querySelectorAll('[data-ordre-id]').forEach((el) => {
  const i = indexDe(el);

  const haut = el.querySelector('[data-monter]');
  const bas = el.querySelector('[data-descendre]');
  if (haut) haut.addEventListener('click', (e) => { e.stopPropagation(); deplacer(i, i - 1); });
  if (bas) bas.addEventListener('click', (e) => { e.stopPropagation(); deplacer(i, i + 1); });

  el.addEventListener('dragstart', (e) => {
    if (e.target !== el) return; // glissement d'un contenu de la ligne (image d'un éditeur…)
    glisse = el.dataset.ordreId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', glisse); // requis par Firefox
    el.classList.add('glisse');
  });
  el.addEventListener('dragend', () => { glisse = null; nettoyer(); });
  el.addEventListener('dragover', (e) => {
    if (glisse === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = el.getBoundingClientRect();
    const apres = e.clientY > r.top + r.height / 2;
    el.classList.toggle('depot-apres', apres);
    el.classList.toggle('depot-avant', !apres);
  });
  el.addEventListener('dragleave', () => el.classList.remove('depot-avant', 'depot-apres'));
  el.addEventListener('drop', (e) => {
    if (glisse === null) return;
    e.preventDefault();
    const apres = el.classList.contains('depot-apres');
    const de = liste.findIndex((x) => String(x.id) === glisse);
    let vers = indexDe(el) + (apres ? 1 : 0);
    if (de < vers) vers--;
    glisse = null;
    nettoyer();
    deplacer(de, vers);
  });
});
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
      ${state.matieres.map((m, i) => `
        <div class="item-liste ${m.id === state.matiereCourante ? 'actif' : ''}" data-matiere="${m.id}" data-ordre-id="${echap(m.id)}" draggable="true" title="Glisser pour réordonner">
          <span>${m.icone || '📘'} ${echap(m.nom)}</span>
          ${m.id === state.matiereCourante ? `<span>${boutonsOrdre(i, state.matieres.length)}</span>` : ''}
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

activerReordonnancement(
  elSidebar,
  state.matieres,
  async () => {
    await writeJson(state.niveauDir, 'matieres.json', state.matieres);
    state.niveauVersion = await bumpVersion(state.niveauDir);
  },
  async () => { renderSidebar(); }
);
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
      <table><thead><tr><th></th><th>Titre</th><th>Résumé</th><th></th></tr></thead><tbody>
        ${liste.map((c, i) => `
          <tr data-ordre-id="${echap(c.id)}" draggable="true">
            <td class="poignee" title="Glisser pour réordonner">⠿</td>
            <td>${echap(c.titre)}</td>
            <td>${echap(c.resume || '')}</td>
            <td class="actions">
              ${boutonsOrdre(i, liste.length)}
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
activerReordonnancement(conteneur, liste, () => enregistrerOrdreMatiere('cours', matiere, liste), renderMatiereDetail);
}

function ouvrirFormCours(matiere, cours, liste) {
const estEdition = !!cours;
elMain.innerHTML = `
  <div class="form-contenu">
    ${barreFormulaire(estEdition ? 'Modifier le cours' : 'Nouveau cours')}
    <div class="carte">
      <div class="ligne">
        <div class="champ"><label>Titre</label><input id="fTitre" value="${estEdition ? echap(cours.titre) : ''}" placeholder="ex : Les fractions" /></div>
        <div class="champ"><label>Résumé (affiché dans la liste des cours)</label><input id="fResume" value="${estEdition ? echap(cours.resume || '') : ''}" /></div>
      </div>
    </div>
    <div id="fContenu"></div>
  </div>`;

const marquerModifie = installerFormulaire(elMain.querySelector('.form-contenu'), enregistrer);
const editeur = creerEditeurRiche(document.getElementById('fContenu'), {
  html: estEdition ? cours.contenu || '' : '',
  surModification: marquerModifie,
  notifier: toast,
});
document.getElementById('fTitre').addEventListener('input', marquerModifie);
document.getElementById('fResume').addEventListener('input', marquerModifie);
if (!estEdition) document.getElementById('fTitre').focus();

async function enregistrer() {
  const titre = document.getElementById('fTitre').value.trim();
  const resume = document.getElementById('fResume').value.trim();
  if (!titre) { toast('Le titre est obligatoire.'); document.getElementById('fTitre').focus(); return false; }
  const contenu = editeur.getHtml();

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
  return true;
}
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
      <table><thead><tr><th></th><th>Titre</th><th>Difficulté</th><th></th></tr></thead><tbody>
        ${liste.map((e, i) => `
          <tr data-ordre-id="${echap(e.id)}" draggable="true">
            <td class="poignee" title="Glisser pour réordonner">⠿</td>
            <td>${echap(e.titre)}</td>
            <td>${echap(e.difficulte || '')}</td>
            <td class="actions">
              ${boutonsOrdre(i, liste.length)}
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
activerReordonnancement(conteneur, liste, () => enregistrerOrdreMatiere('exercices', matiere, liste), renderMatiereDetail);
}

// Lignes de choix d'un QCM. groupe : nom du groupe de boutons radio (unique par question).
function renderChoixEditeur(choix, reponseCorrecte, groupe = 'reponseCorrecte') {
return choix.map((c, i) => `
  <div class="choix-ligne" data-choix-index="${i}">
    <input type="radio" name="${echap(groupe)}" value="${i}" ${i === reponseCorrecte ? 'checked' : ''} title="Bonne réponse" />
    <input type="text" class="valeur-choix" value="${echap(c)}" placeholder="Choix ${i + 1}" />
    <button type="button" class="discret" data-retirer-choix="${i}" title="Retirer ce choix">✕</button>
  </div>`).join('');
}

function ouvrirFormExercice(matiere, exercice, liste) {
const estEdition = !!exercice;
let type = estEdition ? exercice.type : 'qcm';
let choix = estEdition && exercice.choix ? [...exercice.choix] : ['', ''];
let reponseCorrecte = estEdition ? (exercice.reponseCorrecte ?? 0) : 0;

elMain.innerHTML = `
  <div class="form-contenu">
    ${barreFormulaire(estEdition ? "Modifier l'exercice" : 'Nouvel exercice')}
    <div class="carte">
      <div class="ligne">
        <div class="champ"><label>Titre (affiché dans la liste)</label><input id="fTitre" value="${estEdition ? echap(exercice.titre) : ''}" /></div>
        <div class="champ etroit">
          <label>Difficulté</label>
          <select id="fDifficulte">
            ${['Facile', 'Moyen', 'Difficile'].map((d) => `<option ${estEdition && exercice.difficulte === d ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
        </div>
        <div class="champ etroit">
          <label>Type</label>
          <select id="fType">
            <option value="qcm" ${type === 'qcm' ? 'selected' : ''}>QCM</option>
            <option value="texte" ${type === 'texte' ? 'selected' : ''}>Question ouverte</option>
          </select>
        </div>
      </div>
    </div>
    <div class="carte">
      <div class="champ"><label>Question</label><div id="fQuestion"></div></div>
      <div id="zoneChoix"></div>
      <div class="champ"><label>Explication (correction affichée à l'élève)</label><div id="fExplication"></div></div>
    </div>
  </div>`;

const marquerModifie = installerFormulaire(elMain.querySelector('.form-contenu'), enregistrer);
const options = { compact: true, surModification: marquerModifie, notifier: toast };
const edQuestion = creerEditeurRiche(document.getElementById('fQuestion'),
  { ...options, html: estEdition ? htmlDepuisChamp(exercice.question, exercice.question_html) : '' });
const edExplication = creerEditeurRiche(document.getElementById('fExplication'),
  { ...options, html: estEdition ? htmlDepuisChamp(exercice.explication, exercice.explication_html) : '' });

const zoneChoix = document.getElementById('zoneChoix');
function rendreChoix() {
  if (type !== 'qcm') { zoneChoix.innerHTML = ''; return; }
  zoneChoix.innerHTML = `
    <div class="champ">
      <label>Choix (coche la bonne réponse)</label>
      ${renderChoixEditeur(choix, reponseCorrecte)}
      <button type="button" id="btnAjouterChoix" style="margin-top:4px">+ Ajouter un choix</button>
    </div>`;
  zoneChoix.querySelectorAll('.valeur-choix').forEach((input, i) => {
    input.addEventListener('input', () => { choix[i] = input.value; marquerModifie(); });
  });
  zoneChoix.querySelectorAll('[type="radio"]').forEach((radio) => {
    radio.addEventListener('change', () => { reponseCorrecte = Number(radio.value); marquerModifie(); });
  });
  zoneChoix.querySelectorAll('[data-retirer-choix]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.retirerChoix);
      choix.splice(i, 1);
      if (reponseCorrecte === i) reponseCorrecte = 0;
      else if (reponseCorrecte > i) reponseCorrecte--;
      marquerModifie();
      rendreChoix();
    });
  });
  document.getElementById('btnAjouterChoix').addEventListener('click', () => {
    choix.push('');
    marquerModifie();
    rendreChoix();
    zoneChoix.querySelector('.choix-ligne:last-of-type .valeur-choix').focus();
  });
}
rendreChoix();

document.getElementById('fTitre').addEventListener('input', marquerModifie);
document.getElementById('fDifficulte').addEventListener('change', marquerModifie);
document.getElementById('fType').addEventListener('change', (e) => {
  type = e.target.value;
  marquerModifie();
  rendreChoix();
});
if (!estEdition) document.getElementById('fTitre').focus();

async function enregistrer() {
  const titre = document.getElementById('fTitre').value.trim();
  const difficulte = document.getElementById('fDifficulte').value;
  const question = champDepuisHtml(edQuestion.getHtml());
  const explication = champDepuisHtml(edExplication.getHtml());
  if (!titre || !question.texte) { toast('Titre et question sont obligatoires.'); return false; }
  const qcm = type === 'qcm' ? choixValides(choix, reponseCorrecte) : null;
  if (typeof qcm === 'string') { toast(qcm); return false; }

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

  const detail = { id, type, question: question.texte };
  if (question.html) detail.question_html = question.html;
  if (qcm) { detail.choix = qcm.choix; detail.reponseCorrecte = qcm.reponseCorrecte; }
  detail.explication = explication.texte;
  if (explication.html) detail.explication_html = explication.html;
  await writeJson(dirDetail, `${id}.json`, detail);

  const matDir = await getOrCreateDir(state.niveauDir, 'matieres');
  const dirMatiere = await getOrCreateDir(matDir, matiere.id);
  await bumpVersion(dirMatiere);

  toast(estEdition ? 'Exercice modifié.' : 'Exercice créé.');
  return true;
}
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
      <table><thead><tr><th></th><th>Titre</th><th>Durée</th><th>Questions</th><th></th></tr></thead><tbody>
        ${liste.map((ep, i) => `
          <tr data-ordre-id="${echap(ep.id)}" draggable="true">
            <td class="poignee" title="Glisser pour réordonner">⠿</td>
            <td>${echap(ep.titre)}</td>
            <td>${ep.dureeMinutes} min</td>
            <td>${ep.nbQuestions}</td>
            <td class="actions">
              ${boutonsOrdre(i, liste.length)}
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
activerReordonnancement(conteneur, liste, () => enregistrerOrdreMatiere('epreuves', matiere, liste), renderMatiereDetail);
}

function ouvrirFormEpreuve(matiere, epreuve, liste) {
const estEdition = !!epreuve;

// Modèle de travail : une entrée par question, avec le HTML en cours d'édition.
// `ouvert` : carte dépliée (les éditeurs n'existent que pour les cartes ouvertes).
const nouvelleQuestion = () => ({
  id: genererId(`${matiere.id}-q`), type: 'qcm', enonceHtml: '', choix: ['', ''], reponseCorrecte: 0, explicationHtml: '', ouvert: true,
});
const questions = estEdition ? (epreuve.questions || []).map((q) => ({
  id: q.id || genererId(`${matiere.id}-q`),
  type: q.type === 'texte' ? 'texte' : 'qcm',
  enonceHtml: htmlDepuisChamp(q.enonce, q.enonce_html),
  choix: q.choix ? [...q.choix] : ['', ''],
  reponseCorrecte: q.reponseCorrecte ?? 0,
  explicationHtml: htmlDepuisChamp(q.explication, q.explication_html),
  ouvert: false,
})) : [nouvelleQuestion()];

elMain.innerHTML = `
  <div class="form-contenu">
    ${barreFormulaire(estEdition ? "Modifier l'épreuve" : 'Nouvelle épreuve')}
    <div class="carte">
      <div class="ligne">
        <div class="champ"><label>Titre</label><input id="fTitre" value="${estEdition ? echap(epreuve.titre) : ''}" /></div>
        <div class="champ etroit"><label>Durée (minutes)</label><input id="fDuree" type="number" min="1" value="${estEdition ? epreuve.dureeMinutes : 20}" /></div>
        <div class="champ etroit"><label>Barème</label><input id="fBareme" type="number" min="1" value="${estEdition ? (epreuve.bareme || 20) : 20}" /></div>
      </div>
    </div>
    <div class="q-barre">
      <strong id="qCompte"></strong>
      <span>
        <button type="button" class="discret" id="btnToutReplier">Tout replier</button>
        <button type="button" class="discret" id="btnToutDeplier">Tout déplier</button>
      </span>
    </div>
    <div id="zoneQuestions"></div>
    <button type="button" id="btnAjouterQuestion" class="q-ajouter">+ Ajouter une question</button>
  </div>`;

const marquerModifie = installerFormulaire(elMain.querySelector('.form-contenu'), enregistrer);
const zoneQuestions = document.getElementById('zoneQuestions');
let editeurs = new Map(); // id de question → { enonce, explication } (cartes ouvertes seulement)

// Recopie le contenu des éditeurs ouverts dans le modèle (avant tout réaffichage ou enregistrement).
function synchroniser() {
  for (const q of questions) {
    const ed = editeurs.get(q.id);
    if (!ed) continue;
    q.enonceHtml = ed.enonce.getHtml();
    q.explicationHtml = ed.explication.getHtml();
  }
}
// Modifie le modèle puis réaffiche les cartes.
function appliquer(action) {
  synchroniser();
  action();
  marquerModifie();
  rendreQuestions();
}

function rendreQuestions() {
  document.getElementById('qCompte').textContent = `Questions (${questions.length})`;
  zoneQuestions.innerHTML = questions.length === 0
    ? '<p class="vide">Aucune question — ajoutes-en au moins une.</p>'
    : questions.map((q, i) => {
      const resume = texteDepuisHtml(q.enonceHtml).replace(/\s+/g, ' ') || (q.enonceHtml.includes('<img') ? '(image)' : 'Énoncé à rédiger…');
      return `
      <div class="q-carte ${q.ouvert ? 'ouverte' : ''}" data-ordre-id="${echap(q.id)}">
        <div class="q-entete" title="${q.ouvert ? 'Replier' : 'Déplier pour modifier'}">
          <span class="q-poignee" title="Glisser pour réordonner">⠿</span>
          <strong class="q-num">Question ${i + 1}</strong>
          <span class="q-badge">${q.type === 'qcm' ? 'QCM' : 'Ouverte'}</span>
          <span class="q-resume">${echap(resume)}</span>
          <span class="q-actions">
            ${boutonsOrdre(i, questions.length)}
            <button type="button" class="discret" data-dupliquer title="Créer une copie de cette question">⧉ Dupliquer</button>
            <button type="button" class="discret" data-retirer title="Retirer cette question">✕ Retirer</button>
            <span class="q-chevron">${q.ouvert ? '▴' : '▾'}</span>
          </span>
        </div>
        ${q.ouvert ? `
        <div class="q-corps">
          <div class="champ etroit">
            <label>Type</label>
            <select class="q-type">
              <option value="qcm" ${q.type === 'qcm' ? 'selected' : ''}>QCM</option>
              <option value="texte" ${q.type === 'texte' ? 'selected' : ''}>Question ouverte</option>
            </select>
          </div>
          <div class="champ"><label>Énoncé</label><div class="q-enonce"></div></div>
          ${q.type === 'qcm' ? `
            <div class="champ">
              <label>Choix (coche la bonne réponse)</label>
              ${renderChoixEditeur(q.choix, q.reponseCorrecte, `rc-${q.id}`)}
              <button type="button" data-ajouter-choix style="margin-top:4px">+ Ajouter un choix</button>
            </div>` : ''}
          <div class="champ"><label>Explication (correction affichée à l'élève)</label><div class="q-explication"></div></div>
        </div>` : ''}
      </div>`;
    }).join('');

  editeurs = new Map();
  zoneQuestions.querySelectorAll('.q-carte').forEach((carte, i) => {
    const q = questions[i];
    const entete = carte.querySelector('.q-entete');

    // La carte ne devient déplaçable que lorsqu'on la saisit par sa poignée
    // (sinon la sélection de texte dans les éditeurs lancerait un déplacement).
    carte.querySelector('.q-poignee').addEventListener('mousedown', () => { carte.draggable = true; });
    carte.addEventListener('dragend', () => { carte.draggable = false; });
    entete.addEventListener('mouseup', () => { carte.draggable = false; });

    entete.addEventListener('click', (e) => {
      if (e.target.closest('button, .q-poignee')) return;
      appliquerSansModif(() => { q.ouvert = !q.ouvert; });
    });
    carte.querySelector('[data-dupliquer]').addEventListener('click', () => appliquer(() => {
      questions.splice(i + 1, 0, { ...q, choix: [...q.choix], id: genererId(`${matiere.id}-q`), ouvert: true });
    }));
    carte.querySelector('[data-retirer]').addEventListener('click', () => {
      const vide = !q.enonceHtml && !editeurs.get(q.id)?.enonce.getHtml();
      if (!vide && !confirm(`Retirer la question ${i + 1} ?`)) return;
      appliquer(() => { questions.splice(i, 1); });
    });
    if (!q.ouvert) return;

    const options = { compact: true, surModification: marquerModifie, notifier: toast };
    editeurs.set(q.id, {
      enonce: creerEditeurRiche(carte.querySelector('.q-enonce'), { ...options, html: q.enonceHtml }),
      explication: creerEditeurRiche(carte.querySelector('.q-explication'), { ...options, html: q.explicationHtml }),
    });
    carte.querySelector('.q-type').addEventListener('change', (e) => appliquer(() => { q.type = e.target.value; }));
    carte.querySelectorAll('.valeur-choix').forEach((input, ci) => {
      input.addEventListener('input', () => { q.choix[ci] = input.value; marquerModifie(); });
    });
    carte.querySelectorAll('[type="radio"]').forEach((radio) => {
      radio.addEventListener('change', () => { q.reponseCorrecte = Number(radio.value); marquerModifie(); });
    });
    carte.querySelectorAll('[data-retirer-choix]').forEach((btn) => {
      btn.addEventListener('click', () => appliquer(() => {
        const ci = Number(btn.dataset.retirerChoix);
        q.choix.splice(ci, 1);
        if (q.reponseCorrecte === ci) q.reponseCorrecte = 0;
        else if (q.reponseCorrecte > ci) q.reponseCorrecte--;
      }));
    });
    const btnAjoutChoix = carte.querySelector('[data-ajouter-choix]');
    if (btnAjoutChoix) btnAjoutChoix.addEventListener('click', () => {
      appliquer(() => { q.choix.push(''); });
      zoneQuestions.querySelectorAll('.q-carte')[i].querySelector('.choix-ligne:last-of-type .valeur-choix').focus();
    });
  });

  // ▲▼ et glisser-déposer des cartes (l'ordre n'est écrit qu'à l'enregistrement de l'épreuve).
  activerReordonnancement(zoneQuestions, questions, async () => { marquerModifie(); }, async () => rendreQuestions(), { silencieux: true });
  // Le déplacement modifie le tableau avant le réaffichage : on recopie les éditeurs juste avant.
  zoneQuestions.querySelectorAll('[data-monter], [data-descendre]').forEach((b) => b.addEventListener('click', synchroniser, true));
  zoneQuestions.querySelectorAll('.q-carte').forEach((c) => c.addEventListener('drop', synchroniser, true));
}
// Réaffichage sans marquer le formulaire comme modifié (plier / déplier).
function appliquerSansModif(action) {
  synchroniser();
  action();
  rendreQuestions();
}
rendreQuestions();

document.getElementById('btnAjouterQuestion').addEventListener('click', () => {
  appliquer(() => { questions.push(nouvelleQuestion()); });
  const carte = zoneQuestions.querySelector('.q-carte:last-of-type');
  carte.scrollIntoView({ block: 'nearest' });
  editeurs.get(questions[questions.length - 1].id).enonce.focus();
});
document.getElementById('btnToutReplier').addEventListener('click', () => appliquerSansModif(() => questions.forEach((q) => { q.ouvert = false; })));
document.getElementById('btnToutDeplier').addEventListener('click', () => appliquerSansModif(() => questions.forEach((q) => { q.ouvert = true; })));
['fTitre', 'fDuree', 'fBareme'].forEach((id) => document.getElementById(id).addEventListener('input', marquerModifie));
if (!estEdition) document.getElementById('fTitre').focus();

async function enregistrer() {
  synchroniser();
  const titre = document.getElementById('fTitre').value.trim();
  const dureeMinutes = Number(document.getElementById('fDuree').value);
  const bareme = Number(document.getElementById('fBareme').value);
  if (!titre) { toast('Le titre est obligatoire.'); document.getElementById('fTitre').focus(); return false; }
  if (!(dureeMinutes > 0) || !(bareme > 0)) { toast('La durée et le barème doivent être supérieurs à 0.'); return false; }
  if (questions.length === 0) { toast('Ajoute au moins une question.'); return false; }

  // Une question invalide est dépliée et signalée.
  const refuser = (i, message) => {
    appliquerSansModif(() => { questions[i].ouvert = true; });
    zoneQuestions.querySelectorAll('.q-carte')[i].scrollIntoView({ block: 'nearest' });
    toast(`Question ${i + 1} : ${message}`);
    return false;
  };
  const sortie = [];
  for (const [i, q] of questions.entries()) {
    const enonce = champDepuisHtml(q.enonceHtml);
    const explication = champDepuisHtml(q.explicationHtml);
    if (!enonce.texte) return refuser(i, "l'énoncé est vide.");
    const qcm = q.type === 'qcm' ? choixValides(q.choix, q.reponseCorrecte) : null;
    if (typeof qcm === 'string') return refuser(i, qcm.charAt(0).toLowerCase() + qcm.slice(1));
    const question = { id: q.id, type: q.type, enonce: enonce.texte };
    if (enonce.html) question.enonce_html = enonce.html;
    if (qcm) { question.choix = qcm.choix; question.reponseCorrecte = qcm.reponseCorrecte; }
    question.explication = explication.texte;
    if (explication.html) question.explication_html = explication.html;
    sortie.push(question);
  }

  const id = estEdition ? epreuve.id : genererId(`${matiere.id}-ep`);
  const dirListe = await getOrCreateDir(state.niveauDir, 'epreuves');
  const dirDetail = await getOrCreateDir(state.niveauDir, 'epreuves-detail');

  const entreeListe = { id, titre, dureeMinutes, nbQuestions: sortie.length };
  if (estEdition) {
    const idx = liste.findIndex((ep) => ep.id === id);
    liste[idx] = entreeListe;
  } else {
    liste.push(entreeListe);
  }
  await writeJson(dirListe, `${matiere.id}.json`, liste);
  await writeJson(dirDetail, `${id}.json`, { id, titre, dureeMinutes, bareme, questions: sortie });

  const matDir = await getOrCreateDir(state.niveauDir, 'matieres');
  const dirMatiere = await getOrCreateDir(matDir, matiere.id);
  await bumpVersion(dirMatiere);

  toast(estEdition ? 'Épreuve modifiée.' : 'Épreuve créée.');
  return true;
}
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
