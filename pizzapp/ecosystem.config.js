module.exports = {
  apps: [
    {
      name: 'pizzapp',
      script: 'server.js',
      cwd: __dirname,
      instances: 1, // WhatsApp exige 1: cluster duplicaria a sessão e derrubaria a conexão
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '600M',
      autorestart: true,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
