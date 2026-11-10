# Megabac Admin Tool

Outil d'administration pour gérer le contenu pédagogique de Megabac.

## Structure

```
outil-admin/                 # à déployer tel quel (hébergement PHP ou statique)
├── index.html               # Page de garde (mode local / mode distant)
├── accueil.js               # Détection du backend (PHP / ASP.NET) pour le lien distant
├── style.css                # Styles communs
├── README-ADMIN.md          # Documentation détaillée
├── admin/                   # L'éditeur (commun aux deux modes)
│   ├── admin.html
│   ├── app.js               # Logique (CRUD, aperçus)
│   └── remote.js            # Stockage distant (même interface que la File System Access API)
└── api-php/                 # Backend PHP (Apache, ou IIS + PHP)
    ├── admin-api.php
    ├── admin-config.sample.php
    ├── .htaccess
    └── web.config
backend-aspnet/              # Backend ASP.NET Core (sert aussi l'interface)
serveur-donnees/             # Modèles web.config / .htaccess pour le serveur des DONNÉES (cache, CORS)
```

## Fonctionnalités

- [ ] Interface de gestion du contenu
- [ ] Import/export de données
- [ ] Gestion des versions
- [ ] Génération des fichiers JSON
- [ ] Validation des données

## Utilisation

```bash
# Servir outil-admin/ en http(s) puis ouvrir index.html — voir outil-admin/README-ADMIN.md
# (mode local : dossier de l'ordinateur ; mode distant : API PHP ou ASP.NET Core)
```

## Voir aussi

- [megabac](https://github.com/your-user/megabac) - Application mobile
- [megabac-api-backend](https://github.com/your-user/megabac-api-backend) - Backend API
- [megabac-data-server](https://github.com/your-user/megabac-data-server) - Données statiques
