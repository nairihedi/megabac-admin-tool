<?php
// Copie ce fichier en admin-config.php et adapte-le. NE JAMAIS le versionner
// (admin-config.php est dans le .gitignore).
//
// Générer le hash du mot de passe (une seule fois, en ligne de commande) :
//   php -r "echo password_hash('TON_MOT_DE_PASSE', PASSWORD_DEFAULT), PHP_EOL;"
//
// Si possible, place admin-config.php hors de la racine web et change le
// chemin du require dans admin-api.php.
return [
    // Dossier racine des données (contient 6/, 5/, … ) : chemin absolu sur le serveur.
    // Il doit être accessible en écriture par l'utilisateur PHP (www-data, IUSR, IIS_IUSRS…).
    'data_dir' => '/var/www/html/megabac-data',
    // 'data_dir' => 'C:\\inetpub\\wwwroot\\megabac-data',

    'username' => 'admin',
    'password_hash' => '$2y$10$REMPLACE_PAR_LE_HASH_GENERE',
];
