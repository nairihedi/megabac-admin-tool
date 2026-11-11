// ============================================================================
// editeur.js — Éditeur visuel (WYSIWYG) sans dépendance, pour les contenus riches.
//
//   const ed = creerEditeurRiche(hote, { html, surModification });
//   ed.getHtml()  → HTML propre, compatible avec le filtre de la PWA (sanitize.js)
//
// - On écrit directement le rendu final : barre d'outils (titres, gras, listes,
//   encadré, image, saut de page), aucune balise visible.
// - Les images sont affichées comme des images (jamais comme du texte base64) :
//   ajout par bouton, glisser-déposer ou copier-coller ; un clic dessus ouvre une
//   barre (taille, description, alléger, remplacer, supprimer).
// - Les sauts de page (<break /> dans les données) sont des séparateurs visibles
//   « Page 2 », « Page 3 »… comme l'élève les verra.
// - Le texte collé (Word, web) est nettoyé : seule la mise en forme autorisée reste.
//
// Repose sur contenteditable + document.execCommand (Edge / Chrome).
// ============================================================================
(function () {
  'use strict';

  const REGEX_SAUT = /<\s*\/?\s*(?:break|newpage)\b[^>]*>/gi;
  const IMAGE_LARGEUR_MAX = 1000;       // px : au-delà, l'image est réduite à l'import
  const IMAGE_LOURDE = 150 * 1024;      // octets : au-delà, on propose « Alléger »
  const TAILLES_IMAGE = [['Petite', '200'], ['Moyenne', '400'], ['Grande', '']];

  // Liste blanche alignée sur PWA/www/js/sanitize.js (span et div sont dépliés ici).
  const BALISES_OK = new Set([
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'em', 'u', 's', 'sub', 'sup', 'small', 'mark', 'code', 'pre',
    'blockquote', 'q', 'cite', 'abbr',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'figure', 'figcaption', 'img', 'a',
  ]);
  const BALISES_SUPPRIMEES = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'frame', 'frameset', 'link', 'meta', 'title',
    'base', 'form', 'input', 'button', 'textarea', 'select', 'svg', 'math', 'template',
    'noscript', 'audio', 'video', 'source', 'canvas', 'applet', 'head',
  ]);
  const RENOMMER = { b: 'strong', i: 'em', strike: 's', del: 's' };
  const ATTRS = {
    img: ['src', 'alt', 'width'],
    a: ['href'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
    ol: ['start'],
  };
  const BLOCS = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'blockquote', 'pre',
    'table', 'figure', 'hr', 'div',
  ]);
  const IMAGE_DATA_OK = /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;

  const echap = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const estSaut = (n) => n && n.nodeType === 1 && n.classList.contains('ed-saut');
  const estBloc = (n) => n.nodeType === 1 && BLOCS.has(n.tagName.toLowerCase());

  function creerSaut() {
    const saut = document.createElement('div');
    saut.className = 'ed-saut';
    saut.contentEditable = 'false';
    saut.innerHTML = '<span class="ed-saut-txt"></span><button type="button" class="ed-saut-x" title="Supprimer ce saut de page">✕</button>';
    return saut;
  }

  // Copie « propre » des enfants de src dans dest (liste blanche de balises et d'attributs).
  // options.sauts : conserver les marqueurs de saut de page ; options.imagesDistantes :
  // conserver les <img src="http…"> ; options.rejets : compteur d'images écartées.
  function nettoyer(src, dest, options = {}) {
    for (const n of [...src.childNodes]) {
      if (n.nodeType === 3) { dest.appendChild(document.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue; // commentaires (Word…), etc.
      let tag = n.tagName.toLowerCase();
      if (BALISES_SUPPRIMEES.has(tag) || tag.includes(':')) continue; // <o:p> de Word
      if (n.classList.contains('ed-saut')) { if (options.sauts) dest.appendChild(creerSaut()); continue; }

      // Google Docs enveloppe tout dans <b style="font-weight:normal"> : ce n'est pas du gras.
      if (tag === 'b' && /font-weight\s*:\s*(normal|400)/i.test(n.getAttribute('style') || '')) tag = 'span';
      tag = RENOMMER[tag] || tag;
      if (options.sansTitres && /^h[1-6]$/.test(tag)) tag = 'p';
      if (tag === 'div') tag = [...n.children].some(estBloc) ? 'span' : 'p';
      if (!BALISES_OK.has(tag)) { nettoyer(n, dest, options); continue; } // balise inconnue : dépliée

      if (tag === 'img') {
        const srcImg = n.getAttribute('src') || '';
        const distante = /^https?:\/\//i.test(srcImg);
        if (!IMAGE_DATA_OK.test(srcImg) && !(distante && options.imagesDistantes)) {
          if (options.rejets) options.rejets.n++;
          continue;
        }
      }
      const el = document.createElement(tag);
      for (const nom of ATTRS[tag] || []) {
        const v = n.getAttribute(nom);
        if (v === null) continue;
        if (tag === 'a' && !/^(https?:|mailto:)/i.test(v.trim())) continue;
        if (nom === 'width' && !/^\d+$/.test(v)) continue;
        el.setAttribute(nom, v);
      }
      if (tag === 'img' && !el.hasAttribute('alt')) el.setAttribute('alt', '');
      nettoyer(n, el, options);
      dest.appendChild(el);
    }
  }

  // Un bloc sans texte ni élément « plein » (image, trait, tableau) est considéré vide.
  function blocVide(el) {
    if (el.tagName === 'HR' || el.tagName === 'TABLE') return false;
    return !el.textContent.replace(/[\s​]/g, '') && !el.querySelector('img, hr, table');
  }

  // ---------------------------------------------------------------------------
  // Images : lecture, réduction et conversion (WebP) pour garder des JSON légers
  // ---------------------------------------------------------------------------
  const lireDataUri = (blob) => new Promise((resolve, reject) => {
    const lecteur = new FileReader();
    lecteur.onerror = () => reject(new Error('Lecture du fichier impossible.'));
    lecteur.onload = () => resolve(lecteur.result);
    lecteur.readAsDataURL(blob);
  });
  const chargerImage = (src) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error("Ce fichier n'est pas une image valide."));
    img.onload = () => resolve(img);
    img.src = src;
  });

  // Renvoie l'URI la plus légère entre l'original et une version WebP réduite.
  async function optimiserDataUri(uri) {
    if (/^data:image\/gif/i.test(uri)) return uri; // GIF conservé tel quel (animation)
    const img = await chargerImage(uri);
    const largeurSource = img.naturalWidth || 800; // SVG sans dimensions
    const largeur = Math.min(largeurSource, IMAGE_LARGEUR_MAX);
    const hauteur = Math.max(1, Math.round((img.naturalHeight || largeurSource * 0.75) * largeur / largeurSource));
    const canvas = document.createElement('canvas');
    canvas.width = largeur;
    canvas.height = hauteur;
    canvas.getContext('2d').drawImage(img, 0, 0, largeur, hauteur);
    let sortie = canvas.toDataURL('image/webp', 0.82);
    if (!/^data:image\/webp/i.test(sortie)) sortie = canvas.toDataURL('image/png'); // WebP non géré
    // Le SVG n'est pas accepté par la PWA : toujours converti. Sinon, on garde le plus léger.
    const originalAccepte = IMAGE_DATA_OK.test(uri) && largeurSource <= IMAGE_LARGEUR_MAX;
    return originalAccepte && uri.length <= sortie.length ? uri : sortie;
  }
  async function fichierVersDataUri(fichier) {
    return optimiserDataUri(await lireDataUri(fichier));
  }
  const poidsDataUri = (uri) => Math.round((uri.length - uri.indexOf(',') - 1) * 0.75);
  const formaterPoids = (octets) => (octets >= 1024 * 1024 ? `${(octets / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(octets / 1024))} Ko`);

  // ---------------------------------------------------------------------------
  // Éditeur
  // ---------------------------------------------------------------------------
  const OUTILS = [
    { id: 'h2', libelle: 'Titre', titre: 'Titre de partie' },
    { id: 'h3', libelle: 'Sous-titre', titre: 'Sous-titre' },
    { id: 'p', libelle: 'Texte', titre: 'Texte normal' },
    { sep: true },
    { id: 'bold', libelle: '<b>G</b>', titre: 'Gras (Ctrl+B)' },
    { id: 'italic', libelle: '<i>I</i>', titre: 'Italique (Ctrl+I)' },
    { id: 'underline', libelle: '<u>S</u>', titre: 'Souligné (Ctrl+U)' },
    { sep: true },
    { id: 'ul', libelle: '• Liste', titre: 'Liste à puces' },
    { id: 'ol', libelle: '1. Liste', titre: 'Liste numérotée' },
    { id: 'blockquote', libelle: '❝ Encadré', titre: 'Encadré « à retenir »' },
    { sep: true },
    { id: 'image', libelle: '🖼 Image', titre: 'Insérer une image (ou glisse-la / colle-la dans le texte)' },
    { id: 'saut', libelle: '✂ Saut de page', titre: "Nouvelle page pour l'élève (Ctrl+Entrée)" },
    { sep: true },
    { id: 'undo', libelle: '↶', titre: 'Annuler (Ctrl+Z)' },
    { id: 'redo', libelle: '↷', titre: 'Rétablir (Ctrl+Y)' },
    { pousse: true },
    { id: 'source', libelle: '&lt;/&gt;', titre: 'Voir / modifier le code HTML (avancé)' },
  ];

  // Mode compact (questions, explications) : gras, italique, souligné, listes et image seulement.
  const OUTILS_COMPACTS = ['bold', 'italic', 'underline', null, 'ul', 'ol', null, 'image']
    .map((id) => (id ? OUTILS.find((o) => o.id === id) : { sep: true }));

  function creerEditeurRiche(hote, { html = '', compact = false, surModification = () => {}, notifier = () => {} } = {}) {
    hote.classList.add('ed');
    hote.classList.toggle('ed-compact', compact);
    hote.innerHTML = `
      <div class="ed-barre" role="toolbar" aria-label="Mise en forme">
        ${(compact ? OUTILS_COMPACTS : OUTILS).map((o) => o.sep ? '<span class="ed-sep"></span>'
          : o.pousse ? '<span class="ed-pousse"></span>'
          : `<button type="button" class="ed-btn" data-outil="${o.id}" title="${echap(o.titre)}">${o.libelle}</button>`).join('')}
      </div>
      <div class="ed-cadre">
        <div class="ed-zone" contenteditable="true" spellcheck="true" lang="fr"></div>
        <textarea class="ed-source" spellcheck="false" hidden></textarea>
        <div class="ed-img-barre" hidden>
          <span class="ed-img-tailles">
            ${TAILLES_IMAGE.map(([nom, l]) => `<button type="button" data-largeur="${l}">${nom}</button>`).join('')}
          </span>
          <input type="text" class="ed-img-alt" placeholder="Description de l'image" title="Texte lu aux élèves malvoyants et affiché si l'image ne charge pas" />
          <span class="ed-img-poids"></span>
          <button type="button" data-img="alleger" title="Réduit et compresse l'image">Alléger</button>
          <button type="button" data-img="remplacer">Remplacer</button>
          <button type="button" data-img="supprimer" class="ed-danger">Supprimer</button>
        </div>
        <div class="ed-depot" hidden>Dépose l'image ici</div>
      </div>
      <input type="file" accept="image/*" multiple hidden />`;

    const barre = hote.querySelector('.ed-barre');
    const cadre = hote.querySelector('.ed-cadre');
    const zone = hote.querySelector('.ed-zone');
    const source = hote.querySelector('.ed-source');
    const imgBarre = hote.querySelector('.ed-img-barre');
    const depot = hote.querySelector('.ed-depot');
    const inputFichier = hote.querySelector('input[type="file"]');

    let dernierePlage = null;   // dernière sélection connue dans la zone (pour les boutons)
    let imageChoisie = null;    // image sélectionnée (barre d'image ouverte)
    let imageARemplacer = null;
    let modeSource = false;
    let imagesSource = [];      // URI base64 masquées pendant l'édition du code
    let glisseInterne = false;

    // --- Structure -----------------------------------------------------------
    const nouveauParagraphe = () => { const p = document.createElement('p'); p.appendChild(document.createElement('br')); return p; };
    const blocRacine = (n) => { while (n && n.parentNode !== zone) n = n.parentNode; return n && n.nodeType === 1 ? n : null; };

    function placerCurseur(el, fin = false) {
      const plage = document.createRange();
      plage.selectNodeContents(el);
      plage.collapse(!fin);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(plage);
      dernierePlage = plage.cloneRange();
    }

    // Garde une structure saine : uniquement des blocs à la racine, toujours un
    // paragraphe avant le premier saut et après le dernier (pour pouvoir y écrire).
    function garantirStructure() {
      let courant = null;
      for (const n of [...zone.childNodes]) {
        if (n.nodeType === 1 && (estBloc(n) || estSaut(n))) { courant = null; continue; }
        if (n.nodeType === 3 && !n.nodeValue.trim() && !courant) { n.remove(); continue; }
        if (n.nodeType !== 1 && n.nodeType !== 3) { n.remove(); continue; }
        if (!courant) { courant = document.createElement('p'); n.before(courant); }
        courant.appendChild(n); // le nœud garde le curseur s'il le contenait
      }
      if (!zone.firstElementChild || estSaut(zone.firstElementChild)) zone.prepend(nouveauParagraphe());
      if (estSaut(zone.lastElementChild)) zone.append(nouveauParagraphe());
    }

    function charger(contenu) {
      // Comme la PWA : découpage en pages sur le HTML brut, AVANT analyse. Chaque page est
      // analysée seule, donc une balise mal fermée ne déborde jamais sur la page suivante.
      zone.textContent = '';
      String(contenu || '').split(REGEX_SAUT).forEach((page, i) => {
        if (i) zone.appendChild(creerSaut());
        const doc = new DOMParser().parseFromString(`<body>${page}</body>`, 'text/html');
        nettoyer(doc.body, zone, { imagesDistantes: true, sansTitres: compact });
      });
      [...zone.children].forEach((b) => { if (b.tagName === 'P' && blocVide(b)) b.remove(); }); // lignes vides
      garantirStructure();
    }

    function versHtml() {
      const morceaux = [];
      for (const enfant of zone.children) {
        if (estSaut(enfant)) { morceaux.push('<break />'); continue; }
        const enveloppe = document.createElement('div');
        enveloppe.appendChild(enfant.cloneNode(true));
        const propre = document.createElement('div');
        nettoyer(enveloppe, propre, { imagesDistantes: true });
        for (const bloc of propre.children) if (!blocVide(bloc)) morceaux.push(bloc.outerHTML);
      }
      // Pas de saut en tête, en fin, ni en double (pages vides).
      const utiles = morceaux.filter((m, i) => m !== '<break />' || (i > 0 && morceaux[i - 1] !== '<break />'));
      while (utiles[0] === '<break />') utiles.shift();
      while (utiles[utiles.length - 1] === '<break />') utiles.pop();
      return utiles.join('\n');
    }

    function signalerModification() {
      garantirStructure();
      surModification();
    }

    // --- Sélection -----------------------------------------------------------
    function plageCourante() {
      const sel = getSelection();
      if (sel.rangeCount && zone.contains(sel.getRangeAt(0).commonAncestorContainer)) return sel.getRangeAt(0);
      return null;
    }
    function restaurerPlage() {
      zone.focus();
      let plage = plageCourante();
      if (plage) return plage;
      if (dernierePlage && zone.contains(dernierePlage.commonAncestorContainer)) {
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(dernierePlage);
        return dernierePlage;
      }
      placerCurseur(zone.lastElementChild || zone, true);
      return plageCourante();
    }

    function surSelection() {
      if (!zone.isConnected) { document.removeEventListener('selectionchange', surSelection); return; }
      const plage = plageCourante();
      if (!plage) return;
      dernierePlage = plage.cloneRange();
      majBarre();
    }
    document.addEventListener('selectionchange', surSelection);

    function majBarre() {
      const plage = plageCourante();
      const bloc = plage ? blocRacine(plage.startContainer) : null;
      const tag = bloc ? bloc.tagName.toLowerCase() : '';
      const actif = {
        h2: tag === 'h2', h3: tag === 'h3', p: tag === 'p', ul: tag === 'ul', ol: tag === 'ol', blockquote: tag === 'blockquote',
        bold: document.queryCommandState('bold'), italic: document.queryCommandState('italic'), underline: document.queryCommandState('underline'),
        source: modeSource,
      };
      barre.querySelectorAll('[data-outil]').forEach((b) => b.classList.toggle('actif', !!actif[b.dataset.outil]));
    }

    // --- Commandes -----------------------------------------------------------
    function executer(commande, valeur) {
      restaurerPlage();
      document.execCommand('defaultParagraphSeparator', false, 'p');
      document.execCommand('styleWithCSS', false, false);
      document.execCommand(commande, false, valeur);
      signalerModification();
      majBarre();
    }

    // Remplace un bloc racine par un bloc d'un autre type en gardant son contenu (et le curseur).
    function renommerBloc(bloc, tag) {
      const neuf = document.createElement(tag);
      while (bloc.firstChild) neuf.appendChild(bloc.firstChild);
      bloc.replaceWith(neuf);
      if (!neuf.firstChild) neuf.appendChild(document.createElement('br'));
      return neuf;
    }

    function changerBloc(tag) {
      const plage = restaurerPlage();
      const bloc = blocRacine(plage.startContainer);
      if (!bloc || estSaut(bloc)) return;
      const actuel = bloc.tagName.toLowerCase();
      if (actuel === 'ul' || actuel === 'ol') { // sortir de la liste d'abord
        executer(actuel === 'ul' ? 'insertUnorderedList' : 'insertOrderedList');
        if (tag !== 'p') changerBloc(tag);
        return;
      }
      const cible = actuel === tag ? 'p' : tag; // re-cliquer sur le style actif revient au texte normal
      if (actuel === 'blockquote' || cible === 'blockquote') {
        const debut = plage.startContainer, decalage = plage.startOffset;
        const neuf = renommerBloc(bloc, cible);
        if (neuf.contains(debut)) {
          const p = document.createRange();
          p.setStart(debut, decalage);
          p.collapse(true);
          getSelection().removeAllRanges();
          getSelection().addRange(p);
        } else {
          placerCurseur(neuf, true);
        }
        signalerModification();
        majBarre();
      } else {
        executer('formatBlock', cible);
      }
    }

    function insererSaut() {
      const plage = restaurerPlage();
      const bloc = blocRacine(plage.startContainer) || zone.lastElementChild;
      const saut = creerSaut();
      bloc.after(saut);
      let suivant = saut.nextElementSibling;
      if (!suivant || estSaut(suivant)) { suivant = nouveauParagraphe(); saut.after(suivant); }
      placerCurseur(suivant);
      suivant.scrollIntoView({ block: 'nearest' });
      signalerModification();
    }

    function basculerSource() {
      if (!modeSource) {
        imagesSource = [];
        // Les images base64 sont remplacées par un repère court : le code reste lisible.
        source.value = versHtml().replace(/src="(data:image\/[^"]+)"/g, (_, uri) => `src="image-${imagesSource.push(uri)}"`);
        fermerBarreImage();
      } else {
        charger(source.value.replace(/src="image-(\d+)"/g, (m, n) => (imagesSource[n - 1] ? `src="${imagesSource[n - 1]}"` : m)));
        signalerModification();
      }
      modeSource = !modeSource;
      zone.hidden = modeSource;
      source.hidden = !modeSource;
      barre.querySelectorAll('[data-outil]').forEach((b) => { if (b.dataset.outil !== 'source') b.disabled = modeSource; });
      majBarre();
      (modeSource ? source : zone).focus();
    }
    source.addEventListener('input', () => surModification());

    barre.addEventListener('mousedown', (e) => { if (e.target.closest('.ed-btn')) e.preventDefault(); }); // garde la sélection
    barre.addEventListener('click', (e) => {
      const bouton = e.target.closest('[data-outil]');
      if (!bouton || bouton.disabled) return;
      switch (bouton.dataset.outil) {
        case 'h2': case 'h3': case 'p': case 'blockquote': changerBloc(bouton.dataset.outil); break;
        case 'bold': case 'italic': case 'underline': case 'undo': case 'redo': executer(bouton.dataset.outil); break;
        case 'ul': executer('insertUnorderedList'); break;
        case 'ol': executer('insertOrderedList'); break;
        case 'saut': insererSaut(); break;
        case 'image': imageARemplacer = null; inputFichier.click(); break;
        case 'source': basculerSource(); break;
      }
    });

    // --- Images --------------------------------------------------------------
    async function insererImages(fichiers) {
      const images = [...fichiers].filter((f) => f.type.startsWith('image/'));
      if (!images.length) return;
      for (const fichier of images) {
        try {
          const uri = await fichierVersDataUri(fichier);
          restaurerPlage();
          document.execCommand('insertHTML', false, `<img src="${uri}" alt="">`);
          notifier(`Image insérée (${formaterPoids(poidsDataUri(uri))}).`);
        } catch (err) {
          notifier(err.message);
        }
      }
      signalerModification();
    }

    inputFichier.addEventListener('change', async () => {
      const fichiers = [...inputFichier.files];
      inputFichier.value = '';
      if (imageARemplacer && fichiers[0]) {
        const cible = imageARemplacer;
        imageARemplacer = null;
        try {
          cible.src = await fichierVersDataUri(fichiers[0]);
          signalerModification();
          if (cible.isConnected) choisirImage(cible);
        } catch (err) { notifier(err.message); }
        return;
      }
      await insererImages(fichiers);
    });

    function positionnerBarreImage() {
      if (!imageChoisie) return;
      const rc = cadre.getBoundingClientRect();
      const ri = imageChoisie.getBoundingClientRect();
      imgBarre.style.top = `${Math.max(0, ri.top - rc.top - imgBarre.offsetHeight - 6)}px`;
      imgBarre.style.left = `${Math.max(0, Math.min(ri.left - rc.left, rc.width - imgBarre.offsetWidth))}px`;
    }
    function choisirImage(img) {
      fermerBarreImage();
      imageChoisie = img;
      img.classList.add('ed-img-choisie');
      imgBarre.hidden = false;
      imgBarre.querySelector('.ed-img-alt').value = img.getAttribute('alt') || '';
      const largeur = img.getAttribute('width') || '';
      imgBarre.querySelectorAll('[data-largeur]').forEach((b) => b.classList.toggle('actif', b.dataset.largeur === largeur));
      const base64 = img.src.startsWith('data:');
      const poids = base64 ? poidsDataUri(img.src) : 0;
      imgBarre.querySelector('.ed-img-poids').textContent = base64 ? formaterPoids(poids) : 'image en ligne';
      imgBarre.querySelector('[data-img="alleger"]').hidden = !(base64 && poids > IMAGE_LOURDE);
      positionnerBarreImage();
    }
    function fermerBarreImage() {
      if (imageChoisie) imageChoisie.classList.remove('ed-img-choisie');
      imageChoisie = null;
      imgBarre.hidden = true;
    }

    imgBarre.addEventListener('click', async (e) => {
      const img = imageChoisie;
      if (!img) return;
      const taille = e.target.closest('[data-largeur]');
      if (taille) {
        if (taille.dataset.largeur) img.setAttribute('width', taille.dataset.largeur); else img.removeAttribute('width');
        signalerModification();
        choisirImage(img);
        return;
      }
      const action = e.target.closest('[data-img]')?.dataset.img;
      if (action === 'supprimer') {
        fermerBarreImage();
        img.remove();
        signalerModification();
      } else if (action === 'remplacer') {
        imageARemplacer = img;
        inputFichier.click();
      } else if (action === 'alleger') {
        try {
          const avant = poidsDataUri(img.src);
          const uri = await optimiserDataUri(img.src);
          if (uri.length < img.src.length) {
            img.src = uri;
            signalerModification();
            notifier(`Image allégée : ${formaterPoids(avant)} → ${formaterPoids(poidsDataUri(uri))}.`);
          } else {
            notifier("Cette image est déjà au plus léger.");
          }
          if (img.isConnected) choisirImage(img);
        } catch (err) { notifier(err.message); }
      }
    });
    imgBarre.querySelector('.ed-img-alt').addEventListener('input', (e) => {
      if (!imageChoisie) return;
      imageChoisie.setAttribute('alt', e.target.value);
      surModification();
    });

    // --- Événements de la zone -------------------------------------------------
    zone.addEventListener('click', (e) => {
      const croix = e.target.closest('.ed-saut-x');
      if (croix) { croix.closest('.ed-saut').remove(); signalerModification(); return; }
      if (e.target.tagName === 'IMG') choisirImage(e.target); else fermerBarreImage();
    });
    zone.addEventListener('input', () => {
      if (imageChoisie && !imageChoisie.isConnected) fermerBarreImage(); else positionnerBarreImage();
      signalerModification();
    });
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !compact) { e.preventDefault(); insererSaut(); return; }
      if (imageChoisie && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        const img = imageChoisie;
        fermerBarreImage();
        img.remove();
        signalerModification();
        return;
      }
      if (imageChoisie && !e.ctrlKey && !e.metaKey) fermerBarreImage();
    });
    zone.addEventListener('focus', () => document.execCommand('defaultParagraphSeparator', false, 'p'));

    // Collage : image du presse-papiers, HTML nettoyé (Word, web) ou texte brut.
    zone.addEventListener('paste', (e) => {
      const donnees = e.clipboardData;
      if (!donnees) return;
      e.preventDefault();
      const images = [...donnees.files].filter((f) => f.type.startsWith('image/'));
      const htmlColle = donnees.getData('text/html');
      const texte = donnees.getData('text/plain');
      if (htmlColle) {
        const doc = new DOMParser().parseFromString(htmlColle, 'text/html');
        if (images.length && !doc.body.textContent.trim()) { insererImages(images); return; } // image copiée seule
        const propre = document.createElement('div');
        const rejets = { n: 0 };
        nettoyer(doc.body, propre, { rejets, sansTitres: compact });
        [...propre.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li')].forEach((b) => { if (blocVide(b)) b.remove(); });
        document.execCommand('insertHTML', false, propre.innerHTML);
        if (rejets.n) notifier(`${rejets.n} image(s) du texte collé non reprise(s) : ajoute-les avec le bouton Image.`);
      } else if (images.length) {
        insererImages(images);
        return;
      } else if (texte) {
        const lignes = texte.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lignes.length > 1) document.execCommand('insertHTML', false, lignes.map((l) => `<p>${echap(l)}</p>`).join(''));
        else document.execCommand('insertText', false, texte.trim());
      }
      signalerModification();
    });

    // Glisser-déposer d'images depuis l'ordinateur (le déplacement interne reste natif).
    zone.addEventListener('dragstart', () => { glisseInterne = true; });
    zone.addEventListener('dragend', () => { glisseInterne = false; signalerModification(); });
    const estDepotFichier = (e) => !glisseInterne && [...(e.dataTransfer?.types || [])].includes('Files');
    cadre.addEventListener('dragover', (e) => {
      if (!estDepotFichier(e) || modeSource) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      depot.hidden = false;
    });
    cadre.addEventListener('dragleave', (e) => { if (!cadre.contains(e.relatedTarget)) depot.hidden = true; });
    cadre.addEventListener('drop', (e) => {
      depot.hidden = true;
      if (!estDepotFichier(e) || modeSource) return;
      e.preventDefault();
      depot.hidden = true;
      const plage = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
      if (plage && zone.contains(plage.startContainer) && !plage.startContainer.parentElement?.closest('.ed-saut')) {
        getSelection().removeAllRanges();
        getSelection().addRange(plage);
      }
      insererImages(e.dataTransfer.files);
    });

    charger(html);

    return {
      getHtml() {
        if (modeSource) basculerSource();
        return versHtml();
      },
      estVide: () => !versHtml(),
      focus: () => { zone.focus(); placerCurseur(zone.lastElementChild || zone, true); },
    };
  }

  window.creerEditeurRiche = creerEditeurRiche;
})();
