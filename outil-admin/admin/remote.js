// ============================================================================
// remote.js — Mode « distant » : même interface que les handles de la
// File System Access API (le sous-ensemble utilisé par app.js), mais qui
// passe par l'API d'administration du serveur (admin-api.php ou admin-api
// en ASP.NET Core). app.js n'a donc pas besoin de savoir où sont les données.
//
// Contrat de l'API : voir README-ADMIN.md.
// ============================================================================

// Seules ces deux URL (relatives) sont acceptées : évite qu'un lien forgé
// (?api=https://autre-site) envoie le mot de passe ailleurs.
const BACKENDS_DISTANTS = {
  php: '../api-php/admin-api.php',
  aspnet: '../admin-api',
};

class ErreurApi extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

class ApiDistante {
  constructor(backend) {
    if (!BACKENDS_DISTANTS[backend]) throw new Error('Backend inconnu.');
    this.backend = backend;
    this.url = BACKENDS_DISTANTS[backend];
    this.dossiersCrees = new Set(); // évite de refaire un mkdir déjà fait
  }

  async appeler(action, { method = 'GET', params = {}, body } = {}) {
    const qs = new URLSearchParams({ action, ...params });
    const headers = { 'X-Requested-With': 'megabac-admin' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const cible = `${method} ${this.url}?${qs}`;
    let res;
    try {
      res = await fetch(`${this.url}?${qs}`, {
        method, headers, body, credentials: 'same-origin', cache: 'no-store',
      });
    } catch (e) {
      console.error(`[MegabacAdmin] ${cible} → serveur injoignable`, e);
      throw new ErreurApi('Serveur injoignable.', 0);
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const message = data.error || `Erreur serveur (${res.status})`;
      // 404 sur « session » ou lecture d'un fichier absent : cas normaux, pas de bruit.
      if (!(res.status === 404 && (action === 'read' || action === 'list'))) {
        console.warn(`[MegabacAdmin] ${cible} → ${res.status} : ${message}`);
      }
      if (res.status === 401 && action !== 'login' && action !== 'session') {
        this.surSessionExpiree?.();
      }
      throw new ErreurApi(message, res.status);
    }
    return res;
  }

  async json(action, options) {
    return (await this.appeler(action, options)).json();
  }

  async session() {
    try { return (await this.json('session')).authenticated === true; }
    catch { return false; }
  }
  async connexion(user, password) {
    await this.appeler('login', { method: 'POST', body: JSON.stringify({ user, password }) });
  }
  async deconnexion() {
    await this.appeler('logout', { method: 'POST', body: '{}' });
  }

  racine() {
    return new DossierDistant(this, '', 'Serveur');
  }
}

class DossierDistant {
  constructor(api, chemin, nom) {
    this.kind = 'directory';
    this.api = api;
    this.chemin = chemin;
    this.name = nom;
  }

  _enfant(nom) {
    return this.chemin ? `${this.chemin}/${nom}` : nom;
  }

  async getDirectoryHandle(nom, { create = false } = {}) {
    const chemin = this._enfant(nom);
    if (create) {
      if (!this.api.dossiersCrees.has(chemin)) {
        await this.api.appeler('mkdir', { method: 'POST', params: { path: chemin }, body: '{}' });
        this.api.dossiersCrees.add(chemin);
      }
    } else {
      await this.api.appeler('list', { params: { path: chemin } }); // 404 si absent
    }
    return new DossierDistant(this.api, chemin, nom);
  }

  async getFileHandle(nom) {
    // L'existence est vérifiée à la lecture (getFile) ; l'écriture crée le fichier.
    return new FichierDistant(this.api, this._enfant(nom), nom);
  }

  async removeEntry(nom, { recursive = false } = {}) {
    const chemin = this._enfant(nom);
    await this.api.appeler('delete', {
      method: 'POST',
      params: { path: chemin, recursive: recursive ? '1' : '0' },
      body: '{}',
    });
    for (const c of [...this.api.dossiersCrees]) {
      if (c === chemin || c.startsWith(chemin + '/')) this.api.dossiersCrees.delete(c);
    }
  }

  async *entries() {
    const liste = await this.api.json('list', { params: { path: this.chemin } });
    for (const e of liste) yield [e.name, { kind: e.kind }];
  }
}

class FichierDistant {
  constructor(api, chemin, nom) {
    this.kind = 'file';
    this.api = api;
    this.chemin = chemin;
    this.name = nom;
  }

  async getFile() {
    const res = await this.api.appeler('read', { params: { path: this.chemin } });
    const texte = await res.text();
    return { text: async () => texte };
  }

  async createWritable() {
    const api = this.api;
    const chemin = this.chemin;
    let tampon = '';
    return {
      write: async (donnees) => { tampon += donnees; },
      close: async () => {
        await api.appeler('write', { method: 'POST', params: { path: chemin }, body: tampon });
      },
    };
  }
}
