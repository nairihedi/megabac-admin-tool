// ============================================================================
// pdf-import.js — Import d'une page de PDF dans l'éditeur de cours.
//
//   ouvrirImportPdf({ inserer(html, { sautAvant }), notifier(message) })
//
// L'auteur choisit un PDF, une page, puis la forme du résultat :
//   - « Texte modifiable » : le texte de la page est reconstitué en titres,
//     paragraphes et listes (les schémas, images et tableaux ne sont pas repris) ;
//   - « Image » : la page, ou la zone encadrée à la souris, devient une image.
// Une page sans texte (PDF scanné) ne peut être insérée qu'en image.
//
// Tout se passe dans le navigateur : le PDF n'est envoyé nulle part.
// Repose sur PDF.js (../lib/pdfjs/), chargé seulement à la première utilisation.
// Le HTML produit reste dans la liste blanche de l'éditeur (editeur.js).
// ============================================================================
(function () {
  'use strict';

  const BASE_LIB = new URL('../lib/pdfjs/', document.currentScript.src).href;
  const LARGEUR_IMAGE = 1000;   // px : largeur maximale d'une image insérée (comme editeur.js)
  const ECHELLE_MAX = 3;        // une petite zone est agrandie au plus 3 fois (≈ 216 points par pouce)
  const PIXELS_MAX = 16e6;      // garde-fou pour les très grandes pages (affiches, plans)

  const echap = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const formaterPoids = (octets) => (octets >= 1024 * 1024 ? `${(octets / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(octets / 1024))} Ko`);
  const poidsDataUri = (uri) => Math.round((uri.length - uri.indexOf(',') - 1) * 0.75);

  let pdfjsPromesse = null;
  function chargerPdfjs() {
    if (!pdfjsPromesse) {
      pdfjsPromesse = import(`${BASE_LIB}pdf.min.js`).then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = `${BASE_LIB}pdf.worker.min.js`;
        return pdfjs;
      }).catch((err) => { pdfjsPromesse = null; throw err; });
    }
    return pdfjsPromesse;
  }

  // ---------------------------------------------------------------------------
  // Texte de la page → éléments positionnés (repère écran : y vers le bas, en points)
  // ---------------------------------------------------------------------------
  // Gras et italique d'une police, lus dans son fichier (format OpenType, tel que PDF.js le
  // reconstruit) : nom de la police (table « name », ex. « Arial-BoldMT »), style (table
  // « head ») et graisse (table « OS/2 »). Renvoie { gras, ital } ; tout à faux si illisible.
  function styleDePolice(donnees) {
    const style = { gras: false, ital: false };
    try {
      if (!donnees || donnees.length < 12) return style;
      const v = new DataView(donnees.buffer, donnees.byteOffset, donnees.byteLength);
      const tables = {};
      for (let i = 0, n = v.getUint16(4); i < n; i++) {
        const o = 12 + i * 16;
        tables[String.fromCharCode(donnees[o], donnees[o + 1], donnees[o + 2], donnees[o + 3])] = v.getUint32(o + 8);
      }
      let noms = '';
      if (tables.name !== undefined) {
        const t = tables.name;
        const chaines = t + v.getUint16(t + 4);
        for (let i = 0, n = v.getUint16(t + 2); i < n; i++) {
          const e = t + 6 + i * 12;
          const plateforme = v.getUint16(e), id = v.getUint16(e + 6), longueur = v.getUint16(e + 8), debut = chaines + v.getUint16(e + 10);
          if (![1, 2, 4, 6].includes(id) || longueur > 200) continue; // famille, style, nom complet, nom PostScript
          const large = plateforme === 0 || plateforme === 3; // UTF-16
          for (let k = 0; k < longueur; k += large ? 2 : 1) noms += String.fromCharCode(large ? v.getUint16(debut + k) : donnees[debut + k]);
          noms += ' ';
        }
      }
      const macStyle = tables.head !== undefined ? v.getUint16(tables.head + 44) : 0;
      const graisse = tables['OS/2'] !== undefined ? v.getUint16(tables['OS/2'] + 4) : 400;
      style.gras = /bold|black|heavy|semibold|demi/i.test(noms) || !!(macStyle & 1) || (graisse >= 600 && graisse <= 1000);
      style.ital = /italic|oblique/i.test(noms) || !!(macStyle & 2);
    } catch { /* police inhabituelle : considérée comme normale */ }
    return style;
  }

  async function lireElements(page) {
    const vue = page.getViewport({ scale: 1 });
    const contenu = await page.getTextContent();
    const polices = new Map();
    const style = (nom) => {
      if (!polices.has(nom)) {
        let donnees = null;
        try { if (page.commonObjs.has(nom)) donnees = page.commonObjs.get(nom)?.data; } catch { /* police non résolue */ }
        polices.set(nom, styleDePolice(donnees));
      }
      return polices.get(nom);
    };
    return contenu.items.filter((i) => typeof i.str === 'string' && i.str).map((i) => {
      const [x, y] = vue.convertToViewportPoint(i.transform[4], i.transform[5]);
      return { s: i.str, x, y, h: i.height || Math.hypot(i.transform[2], i.transform[3]) || 10, w: i.width || 0, ...style(i.fontName) };
    });
  }

  // ---------------------------------------------------------------------------
  // Éléments → HTML (titres h2/h3, paragraphes, listes, gras, italique, exposants)
  // ---------------------------------------------------------------------------
  const RE_PUCE = /^\s*[•◦▪■□●○‣⁃∙·–—-]\s+(?=\S)/;
  const RE_NUMERO = /^\s*(\d{1,2})[.)]\s+(?=\S)/;
  const RE_FOLIO = /^(page\s*)?\d{1,4}(\s*(\/|sur)\s*\d{1,4})?$/i;
  // Second élément d'un mot composé : le trait d'union de fin de ligne est alors conservé.
  const RE_COMPOSE = /^(là|ci|il|elle|on|ils|elles|je|tu|nous|vous|ce|même|mêmes|à|dire|être|t|y|en|le|la|les|moi|toi|lui|leur|un|une|deux|vis|dessus|dessous|delà)(?![a-zà-ÿ])/i;

  const texteDe = (segs) => segs.map((s) => s.t).join('');

  function retirerDebut(segs, n) {
    while (n > 0 && segs.length) {
      if (segs[0].t.length <= n) { n -= segs[0].t.length; segs.shift(); } else { segs[0].t = segs[0].t.slice(n); n = 0; }
    }
  }

  function segsVersHtml(segs, sansGras) {
    // Fusion des segments de même style ; une espace isolée prend le style de ce qui précède.
    const fusion = [];
    for (const s of segs) {
      const t = s.t.replace(/\s+/g, ' ');
      if (!t) continue;
      const dernier = fusion[fusion.length - 1];
      const blanc = t === ' ';
      if (blanc && dernier && (dernier.sup || dernier.sub)) { fusion.push({ t }); continue; } // l'espace reste hors de l'exposant
      if (dernier && (blanc || (dernier.gras === s.gras && dernier.ital === s.ital && dernier.sup === s.sup && dernier.sub === s.sub))) {
        dernier.t = (dernier.t + t).replace(/ {2,}/g, ' ');
      } else if (!blanc || fusion.length) {
        fusion.push({ ...s, t });
      }
    }
    if (!fusion.length) return '';
    fusion[0].t = fusion[0].t.replace(/^ /, '');
    fusion[fusion.length - 1].t = fusion[fusion.length - 1].t.replace(/ $/, '');
    return fusion.map((s) => {
      let t = echap(s.t);
      if (!t) return '';
      if (s.sup) t = `<sup>${t}</sup>`; else if (s.sub) t = `<sub>${t}</sub>`;
      if (s.ital) t = `<em>${t}</em>`;
      if (s.gras && !sansGras) t = `<strong>${t}</strong>`;
      return t;
    }).join('');
  }

  // elements : sortie de lireElements pour la page ENTIÈRE (les repères — taille du corps de
  // texte, interligne — se mesurent sur toute la page, même si on n'en garde qu'une zone).
  // options.garder(ligne) : ne conserve que certaines lignes (zone encadrée) ;
  // options.hauteur + options.sansFolio : retire les numéros de page en haut et en bas.
  function convertirTexte(elements, { hauteur = 0, sansFolio = false, garder = null } = {}) {
    // 1. Lignes, dans l'ordre du PDF (respecte en général les colonnes).
    const lignes = [];
    let l = null;
    for (const e of elements) {
      if (!e.s.trim()) { if (l) l.segs.push({ t: ' ' }); continue; }
      let role = '';
      if (l) {
        const dy = e.y - l.y;
        const petit = e.h < l.h * 0.9;
        if (petit && Math.abs(dy) > l.h * 0.12 && Math.abs(dy) < l.h * 0.9 && e.x >= l.xFin - l.h) role = dy < 0 ? 'sup' : 'sub';
        else if (Math.abs(dy) <= l.h * 0.3) role = 'n';
      }
      if (!role) {
        l = { x: e.x, y: e.y, h: e.h, xFin: e.x, segs: [] };
        lignes.push(l);
        role = 'n';
      } else if (e.x - l.xFin > e.h * 0.2 && !/\s$/.test(texteDe(l.segs)) && !/^\s/.test(e.s)) {
        l.segs.push({ t: ' ' }); // deux morceaux écartés sans espace entre eux (cellules de tableau…)
      }
      l.segs.push({ t: e.s, gras: !!e.gras, ital: !!e.ital, sup: role === 'sup', sub: role === 'sub' });
      if (role === 'n' && e.h > l.h) { l.h = e.h; l.y = e.y; }
      l.xFin = Math.max(l.xFin, e.x + e.w);
    }
    for (const ligne of lignes) {
      ligne.texte = texteDe(ligne.segs).replace(/\s+/g, ' ').trim();
      const pleins = ligne.segs.filter((s) => s.t.trim() && !s.sup && !s.sub);
      ligne.gras = pleins.length > 0 && pleins.every((s) => s.gras);
    }
    let utiles = lignes.filter((ligne) => ligne.texte);
    if (sansFolio && hauteur) {
      utiles = utiles.filter((ligne) => !((ligne.y < hauteur * 0.08 || ligne.y > hauteur * 0.92) && RE_FOLIO.test(ligne.texte)));
    }
    if (!utiles.length) return { html: '', blocs: 0 };

    // 2. Repères : taille du corps de texte, interligne habituel, bord droit.
    const arrondi = (h) => Math.round(h * 2) / 2;
    const parTaille = new Map();
    for (const ligne of utiles) parTaille.set(arrondi(ligne.h), (parTaille.get(arrondi(ligne.h)) || 0) + ligne.texte.length);
    const corps = [...parTaille.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const estCorps = (ligne) => Math.abs(ligne.h - corps) <= corps * 0.08;
    const ecarts = [];
    for (let i = 1; i < utiles.length; i++) {
      const e = utiles[i].y - utiles[i - 1].y;
      if (e > 0 && e < corps * 3 && estCorps(utiles[i]) && estCorps(utiles[i - 1])) ecarts.push(e);
    }
    ecarts.sort((a, b) => a - b);
    const interligne = ecarts.length ? ecarts[Math.floor((ecarts.length - 1) / 2)] : corps * 1.25;
    const lignesCorps = utiles.filter(estCorps);
    const droite = Math.max(...lignesCorps.map((ligne) => ligne.xFin));
    // Un document tout en gras ne se sert pas du gras pour ses titres.
    const grasParlant = lignesCorps.filter((ligne) => ligne.gras).length < lignesCorps.length * 0.5;

    // 3. Nature de chaque ligne : titre, puce, numéro ou texte.
    utiles.forEach((ligne, i) => {
      const ratio = ligne.h / corps;
      const precedente = utiles[i - 1];
      const suivante = utiles[i + 1];
      if (ratio >= 1.35) ligne.titre = 'h2';
      else if (ratio >= 1.12) ligne.titre = 'h3';
      else if (grasParlant && ligne.gras && estCorps(ligne) && ligne.texte.length <= 120 && !/[.;,]$/.test(ligne.texte) && !RE_PUCE.test(ligne.texte)) {
        const isoleeAvant = !precedente || ligne.y - precedente.y > interligne * 1.2 || ligne.y < precedente.y || /[.!?…:]$/.test(precedente.texte);
        const isoleeApres = !suivante || !suivante.gras || suivante.y - ligne.y > interligne * 1.2;
        if (isoleeAvant && isoleeApres) ligne.titre = 'h3';
      }
      if (ligne.titre) return;
      const brut = texteDe(ligne.segs);
      const puce = brut.match(RE_PUCE);
      const numero = puce ? null : brut.match(RE_NUMERO);
      if (puce) { ligne.liste = 'ul'; retirerDebut(ligne.segs, puce[0].length); }
      else if (numero) { ligne.liste = 'ol'; ligne.numero = Number(numero[1]); retirerDebut(ligne.segs, numero[0].length); }
    });

    // 4. Regroupement des lignes en blocs (uniquement celles de la zone demandée).
    if (garder) utiles = utiles.filter(garder);
    const blocs = [];
    let b = null;
    let prec = null;
    const nouveau = (type, ligne) => { b = { type, segs: [...ligne.segs], liste: ligne.liste, numero: ligne.numero, xPuce: ligne.x }; blocs.push(b); };
    const ajouter = (ligne) => {
      const fin = texteDe(b.segs);
      const dernier = b.segs[b.segs.length - 1];
      if (/­\s*$/.test(fin)) {
        dernier.t = dernier.t.replace(/­\s*$/, ''); // césure « invisible » : le mot est recollé
      } else if (/[A-Za-zÀ-ÿ]-$/.test(fin) && /^[a-zà-ÿ]/.test(ligne.texte)) {
        if (!RE_COMPOSE.test(ligne.texte)) dernier.t = dernier.t.replace(/-$/, ''); // mot coupé en fin de ligne
      } else {
        b.segs.push({ t: ' ' });
      }
      b.segs.push(...ligne.segs);
    };
    for (const ligne of utiles) {
      const ecart = prec ? ligne.y - prec.y : 0;
      const suite = prec && ecart > 0;
      if (ligne.titre) {
        if (b && b.type === ligne.titre && prec.titre && suite && ecart <= ligne.h * 1.6) ajouter(ligne); else nouveau(ligne.titre, ligne);
      } else if (ligne.liste) {
        nouveau('li', ligne);
      } else if (b && b.type === 'li' && suite && ligne.x > b.xPuce + ligne.h * 0.4 && ecart <= interligne * 1.8) {
        ajouter(ligne);
      } else if (b && b.type === 'p' && suite && ecart <= interligne * 1.35 + 0.5 && Math.abs(ligne.h - prec.h) <= corps * 0.08
        && !(/[.!?…:»]$/.test(prec.texte) && (prec.xFin < droite - corps * 2.5 || ligne.x > prec.x + corps))) {
        ajouter(ligne);
      } else {
        nouveau('p', ligne);
      }
      prec = ligne;
    }

    // 5. HTML : les éléments de liste consécutifs sont réunis.
    const morceaux = [];
    let listeOuverte = '';
    let n = 0;
    for (const bloc of blocs) {
      const contenu = segsVersHtml(bloc.segs, bloc.type === 'h2' || bloc.type === 'h3');
      if (!contenu) continue;
      n++;
      if (bloc.type === 'li') {
        if (listeOuverte !== bloc.liste) {
          if (listeOuverte) morceaux.push(`</${listeOuverte}>`);
          morceaux.push(bloc.liste === 'ol' && bloc.numero > 1 ? `<ol start="${bloc.numero}">` : `<${bloc.liste}>`);
          listeOuverte = bloc.liste;
        }
        morceaux.push(`<li>${contenu}</li>`);
        continue;
      }
      if (listeOuverte) { morceaux.push(`</${listeOuverte}>`); listeOuverte = ''; }
      morceaux.push(`<${bloc.type}>${contenu}</${bloc.type}>`);
    }
    if (listeOuverte) morceaux.push(`</${listeOuverte}>`);
    // Espaces insécables de la typographie française : pas de « » : ; ! ? seul en début de ligne.
    const html = morceaux.join('\n').replace(/« /g, '« ').replace(/ ([»:;!?])/g, ' $1');
    return { html, blocs: n };
  }

  // Vrai si le texte extrait est inexploitable : certains PDF dessinent les bonnes lettres sans
  // indiquer à quels caractères elles correspondent (police au codage « maison »). On obtient
  // alors des caractères de contrôle ou « à usage privé », affichés comme des carrés.
  function texteIllisible(texte) {
    const utiles = String(texte).replace(/\s/g, '');
    if (utiles.length < 8) return false;
    const douteux = (utiles.match(/[\u0000-\u001F\u007F-\u009F-￰-￿]/g) || []).length;
    const lisibles = (utiles.match(/[\p{L}\p{N}]/gu) || []).length;
    return douteux / utiles.length > 0.15 || lisibles / utiles.length < 0.5;
  }

  // ---------------------------------------------------------------------------
  // Page (ou zone) → image WebP
  // ---------------------------------------------------------------------------
  // zone : { x0, y0, x1, y1 } en fractions de la page, ou null pour la page entière.
  async function imageDeLaPage(page, zone) {
    const base = page.getViewport({ scale: 1 });
    const z = zone || { x0: 0, y0: 0, x1: 1, y1: 1 };
    const largeurZone = (z.x1 - z.x0) * base.width;
    let echelle = Math.min(LARGEUR_IMAGE / largeurZone, ECHELLE_MAX);
    echelle = Math.min(echelle, Math.sqrt(PIXELS_MAX / (base.width * base.height)));
    const vue = page.getViewport({ scale: echelle });
    const plein = document.createElement('canvas');
    plein.width = Math.round(vue.width);
    plein.height = Math.round(vue.height);
    await page.render({ canvas: plein, canvasContext: plein.getContext('2d'), viewport: vue }).promise;
    let sortie = plein;
    if (zone) {
      const x = Math.round(z.x0 * plein.width), y = Math.round(z.y0 * plein.height);
      sortie = document.createElement('canvas');
      sortie.width = Math.max(1, Math.round((z.x1 - z.x0) * plein.width));
      sortie.height = Math.max(1, Math.round((z.y1 - z.y0) * plein.height));
      sortie.getContext('2d').drawImage(plein, x, y, sortie.width, sortie.height, 0, 0, sortie.width, sortie.height);
    }
    let uri = sortie.toDataURL('image/webp', 0.82);
    if (!/^data:image\/webp/i.test(uri)) uri = sortie.toDataURL('image/png'); // WebP non géré
    return { uri, largeur: sortie.width, hauteur: sortie.height };
  }

  // ---------------------------------------------------------------------------
  // Fenêtre d'import
  // ---------------------------------------------------------------------------
  function ouvrirFenetre(pdfjs, doc, nomFichier, { inserer, notifier }) {
    const dialogue = document.createElement('dialog');
    dialogue.className = 'pdf';
    dialogue.innerHTML = `
      <div class="pdf-tete">
        <strong class="pdf-nom"></strong>
        <span class="pdf-nav">
          <button type="button" data-nav="-1" title="Page précédente (←)">‹</button>
          <label>Page <input type="number" class="pdf-num" min="1" max="${doc.numPages}" value="1" /> / ${doc.numPages}</label>
          <button type="button" data-nav="1" title="Page suivante (→)">›</button>
        </span>
        <span class="pdf-modes" role="group" aria-label="Forme du résultat">
          <button type="button" data-mode="texte" title="Titres, paragraphes et listes, à retoucher dans l'éditeur">Texte modifiable</button>
          <button type="button" data-mode="image" title="La page ou la zone encadrée, telle quelle">Image</button>
        </span>
        <span class="ed-pousse"></span>
        <button type="button" class="discret" data-fermer title="Fermer (Échap)">✕</button>
      </div>
      <div class="pdf-corps">
        <div class="pdf-page">
          <p class="pdf-aide">Trace un rectangle sur la page pour n'en prendre qu'une partie.
            <button type="button" class="discret pdf-entiere" hidden>↺ Page entière</button></p>
          <div class="pdf-feuille"><canvas></canvas><div class="pdf-zone" hidden></div></div>
        </div>
        <div class="pdf-resultat">
          <p class="pdf-info"></p>
          <label class="pdf-alt" hidden>Description de l'image
            <input type="text" placeholder="ex : Frise chronologique de la Préhistoire" /></label>
          <div class="pdf-apercu ed-zone"></div>
        </div>
      </div>
      <div class="pdf-pied">
        <label class="pdf-saut"><input type="checkbox" /> Commencer une nouvelle page pour l'élève</label>
        <span class="ed-pousse"></span>
        <span class="pdf-etat"></span>
        <button type="button" data-fermer>Fermer</button>
        <button type="button" data-inserer="suite">Insérer et page suivante</button>
        <button type="button" class="primaire" data-inserer="fin">Insérer</button>
      </div>`;
    const q = (sel) => dialogue.querySelector(sel);
    q('.pdf-nom').textContent = nomFichier;
    const canvas = q('canvas');
    const feuille = q('.pdf-feuille');
    const cadreZone = q('.pdf-zone');
    const apercu = q('.pdf-apercu');
    const info = q('.pdf-info');
    const champNum = q('.pdf-num');
    const champAlt = q('.pdf-alt input');

    let numero = 0;
    let page = null;
    let dimensions = null;    // { width, height } de la page en points
    let elements = [];
    let avecTexte = false;
    let mode = 'texte';
    let modeVoulu = 'texte';  // choix de l'auteur, repris à la page suivante
    let zone = null;
    let resultat = null;      // { html } prêt à insérer
    let jeton = 0;            // invalide les calculs d'une page ou d'une zone quittée
    let tacheApercu = null;
    let inserees = 0;

    const majCommandes = () => {
      dialogue.querySelectorAll('[data-mode]').forEach((b) => {
        b.classList.toggle('actif', b.dataset.mode === mode);
        if (b.dataset.mode === 'texte') b.disabled = !avecTexte;
      });
      q('[data-nav="-1"]').disabled = numero <= 1;
      q('[data-nav="1"]').disabled = numero >= doc.numPages;
      q('[data-inserer="suite"]').disabled = !resultat || numero >= doc.numPages;
      q('[data-inserer="fin"]').disabled = !resultat;
      q('.pdf-alt').hidden = mode !== 'image';
      q('.pdf-entiere').hidden = !zone;
      cadreZone.hidden = !zone;
      if (zone) {
        cadreZone.style.left = `${zone.x0 * 100}%`;
        cadreZone.style.top = `${zone.y0 * 100}%`;
        cadreZone.style.width = `${(zone.x1 - zone.x0) * 100}%`;
        cadreZone.style.height = `${(zone.y1 - zone.y0) * 100}%`;
      }
    };

    async function majResultat() {
      const monJeton = ++jeton;
      resultat = null;
      majCommandes();
      try {
        if (mode === 'texte') {
          // Une ligne est dans la zone si son début (à mi-hauteur des lettres) s'y trouve.
          const dansZone = (l) => l.x >= zone.x0 * dimensions.width - 1 && l.x <= zone.x1 * dimensions.width
            && l.y - l.h * 0.4 >= zone.y0 * dimensions.height && l.y - l.h * 0.4 <= zone.y1 * dimensions.height;
          const { html, blocs } = convertirTexte(elements, { hauteur: dimensions.height, sansFolio: !zone, garder: zone ? dansZone : null });
          apercu.innerHTML = html;
          if (html && texteIllisible(apercu.textContent)) {
            // Le PDF affiche bien ses lettres mais ne dit pas à quels caractères elles correspondent.
            apercu.textContent = '';
            info.textContent = "Le texte de cette " + (zone ? 'zone' : 'page') + " ne peut pas être récupéré : ce PDF ne permet pas de retrouver les caractères derrière les lettres affichées (on n'obtient que des signes illisibles). Passe en « Image » pour l'insérer tel quel.";
          } else if (html) {
            resultat = { html };
            info.textContent = `${blocs} bloc${blocs > 1 ? 's' : ''} de texte, à retoucher ensuite dans l'éditeur. Les schémas, images et tableaux ne sont pas repris : passe en « Image » et encadre-les.`;
          } else {
            info.textContent = zone ? 'Aucun texte dans la zone encadrée.' : 'Aucun texte sur cette page.';
          }
        } else {
          info.textContent = 'Préparation de l\'image…';
          apercu.textContent = '';
          const image = await imageDeLaPage(page, zone);
          if (monJeton !== jeton) return;
          const img = new Image();
          img.src = image.uri;
          img.alt = '';
          apercu.appendChild(img);
          resultat = { uri: image.uri };
          info.textContent = (avecTexte ? '' : "Cette page ne contient pas de texte (page scannée ou image) : elle ne peut être insérée qu'en image. ")
            + `Image de ${image.largeur} × ${image.hauteur} px, ${formaterPoids(poidsDataUri(image.uri))}.`
            + (zone ? '' : ' Une page entière se lit mal sur téléphone (l\'élève devra zoomer) : encadre plutôt le schéma ou le passage utile.');
        }
      } catch (err) {
        if (monJeton !== jeton) return;
        info.textContent = `Impossible de préparer cette page : ${err.message || err}`;
      }
      if (monJeton === jeton) majCommandes();
    }

    async function afficherPage(n) {
      n = Math.min(Math.max(1, n | 0), doc.numPages);
      const monJeton = ++jeton;
      numero = n;
      champNum.value = n;
      zone = null;
      resultat = null;
      info.textContent = 'Chargement de la page…';
      apercu.textContent = '';
      majCommandes();
      try {
        if (tacheApercu) { tacheApercu.cancel(); tacheApercu = null; }
        const p = await doc.getPage(n);
        if (monJeton !== jeton) return;
        const base = p.getViewport({ scale: 1 });
        // Aperçu : à la largeur disponible, net sur les écrans à haute densité.
        const largeurCss = Math.max(240, Math.min(q('.pdf-page').clientWidth - 34, 700)); // 34 = marges du panneau
        const densite = Math.min(window.devicePixelRatio || 1, 2);
        const vue = p.getViewport({ scale: (largeurCss / base.width) * densite });
        canvas.width = Math.round(vue.width);
        canvas.height = Math.round(vue.height);
        feuille.style.width = `${largeurCss}px`;
        tacheApercu = p.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vue });
        await tacheApercu.promise;
        tacheApercu = null;
        if (monJeton !== jeton) return;
        const lus = await lireElements(p); // après le rendu : les polices (gras, italique) sont connues
        if (monJeton !== jeton) return;
        page = p;
        dimensions = { width: base.width, height: base.height };
        elements = lus;
        avecTexte = elements.some((e) => e.s.trim());
        mode = avecTexte ? modeVoulu : 'image';
        await majResultat();
      } catch (err) {
        if (monJeton !== jeton || err?.name === 'RenderingCancelledException') return;
        info.textContent = `Impossible d'afficher la page ${n} : ${err.message || err}`;
      }
    }

    function insererResultat(suite) {
      if (!resultat) return;
      const html = resultat.uri ? `<p><img src="${resultat.uri}" alt="${echap(champAlt.value.trim())}"></p>` : resultat.html;
      inserer(html, { sautAvant: q('.pdf-saut input').checked });
      inserees++;
      q('.pdf-etat').textContent = `Page ${numero} insérée dans le cours.`;
      champAlt.value = '';
      if (suite && numero < doc.numPages) afficherPage(numero + 1); else dialogue.close();
    }

    // --- Zone tracée à la souris (ou au doigt) ---------------------------------
    let depart = null;
    const fraction = (e) => {
      const r = feuille.getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
    };
    feuille.addEventListener('pointerdown', (e) => {
      if (e.button || !page) return;
      e.preventDefault();
      depart = fraction(e);
      feuille.setPointerCapture(e.pointerId);
    });
    feuille.addEventListener('pointermove', (e) => {
      if (!depart) return;
      const f = fraction(e);
      zone = { x0: Math.min(depart.x, f.x), y0: Math.min(depart.y, f.y), x1: Math.max(depart.x, f.x), y1: Math.max(depart.y, f.y) };
      majCommandes();
    });
    const finTrace = () => {
      if (!depart) return;
      depart = null;
      if (zone && (zone.x1 - zone.x0 < 0.02 || zone.y1 - zone.y0 < 0.01)) zone = null; // simple clic : page entière
      majResultat();
    };
    feuille.addEventListener('pointerup', finTrace);
    feuille.addEventListener('pointercancel', finTrace);

    // --- Commandes ---------------------------------------------------------------
    dialogue.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.dataset.nav) afficherPage(numero + Number(b.dataset.nav));
      else if (b.dataset.mode) { mode = modeVoulu = b.dataset.mode; majResultat(); }
      else if (b.dataset.inserer) insererResultat(b.dataset.inserer === 'suite');
      else if (b.classList.contains('pdf-entiere')) { zone = null; majResultat(); }
      else if ('fermer' in b.dataset) dialogue.close();
    });
    champNum.addEventListener('change', () => afficherPage(Number(champNum.value) || numero));
    dialogue.addEventListener('keydown', (e) => {
      if (e.target.closest('input')) { if (e.key === 'Enter') e.preventDefault(); return; }
      if (e.key === 'ArrowRight' && numero < doc.numPages) afficherPage(numero + 1);
      else if (e.key === 'ArrowLeft' && numero > 1) afficherPage(numero - 1);
    });
    dialogue.addEventListener('close', () => {
      jeton++;
      if (tacheApercu) tacheApercu.cancel();
      dialogue.remove();
      doc.loadingTask.destroy().catch(() => {});
      if (inserees) notifier(`${inserees} page${inserees > 1 ? 's' : ''} du PDF insérée${inserees > 1 ? 's' : ''} dans le cours.`);
    });

    document.body.appendChild(dialogue);
    dialogue.showModal();
    afficherPage(1);
  }

  // Choix du fichier puis ouverture de la fenêtre.
  function ouvrirImportPdf({ inserer, notifier = () => {} }) {
    const champ = document.createElement('input');
    champ.type = 'file';
    champ.accept = 'application/pdf,.pdf';
    champ.addEventListener('change', async () => {
      const fichier = champ.files[0];
      if (!fichier) return;
      notifier('Ouverture du PDF…');
      try {
        const pdfjs = await chargerPdfjs();
        const doc = await pdfjs.getDocument({
          data: await fichier.arrayBuffer(),
          wasmUrl: `${BASE_LIB}wasm/`,
          useWasm: false,        // décodeurs d'images en JavaScript : aucun réglage serveur pour les .wasm
          fontExtraProperties: true, // garde les données des polices : on y lit le gras et l'italique
          isEvalSupported: false,
        }).promise;
        ouvrirFenetre(pdfjs, doc, fichier.name, { inserer, notifier });
      } catch (err) {
        notifier(err?.name === 'PasswordException' ? 'Ce PDF est protégé par un mot de passe : il ne peut pas être importé.'
          : err?.name === 'InvalidPDFException' ? "Ce fichier n'est pas un PDF lisible."
          : `Import PDF impossible : ${err?.message || err}`);
      }
    });
    champ.click();
  }

  window.ouvrirImportPdf = ouvrirImportPdf;
  window.ouvrirImportPdf.convertirTexte = convertirTexte; // exposé pour les tests
  window.ouvrirImportPdf.texteIllisible = texteIllisible;
})();
