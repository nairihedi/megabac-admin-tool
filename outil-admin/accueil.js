// ============================================================================
// accueil.js — Détecte quel backend d'administration répond sur ce serveur
// (PHP ou ASP.NET Core) et configure l'unique lien « Mode distant ».
// Chaque backend répond à GET ?action=ping par {"ok":true,"backend":"php"|"aspnet"}.
// ============================================================================
const CANDIDATS = [
  { backend: 'php', url: 'api-php/admin-api.php', nom: 'PHP' },
  { backend: 'aspnet', url: 'admin-api', nom: 'ASP.NET Core' },
];

const lienDistant = document.getElementById('lienDistant');
const infoDistant = document.getElementById('infoDistant');

async function sonder(candidat) {
  try {
    const res = await fetch(`${candidat.url}?action=ping`, { cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    return data.ok === true && data.backend === candidat.backend;
  } catch {
    return false; // 404, réponse non JSON (ex. serveur de fichiers simple), etc.
  }
}

(async () => {
  for (const candidat of CANDIDATS) {
    if (await sonder(candidat)) {
      lienDistant.href = `admin/admin.html?mode=distant&backend=${candidat.backend}`;
      lienDistant.removeAttribute('aria-disabled');
      infoDistant.textContent = `Édite les données hébergées sur le serveur (${candidat.nom}). Connexion requise.`;
      return;
    }
  }
  infoDistant.textContent = 'Indisponible : aucun backend PHP ou ASP.NET Core détecté sur ce serveur.';
  lienDistant.addEventListener('click', (e) => e.preventDefault());
})();
