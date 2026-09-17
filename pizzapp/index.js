const express = require('express');
const mysql = require('mysql2');

const app = express();
const PORT = 3000;

// Configuração da conexão com o MariaDB/MySQL
const connection = mysql.createConnection({
  host: 'localhost',
  user: 'app_user',
  password: 'Diarrei@5', // Insira a senha do seu usuário root, caso tenha configurado
});

app.get('/', (req, res) => {
  // Executa a query SELECT NOW()
  connection.query('SELECT NOW() AS data_atual', (err, results) => {
    if (err) {
      console.error('Erro ao executar query no MySQL:', err);
      return res.status(500).json({ error: 'Erro ao consultar o banco de dados' });
    }

    // Retorna o resultado do banco no navegador
    res.json({
      mensagem: 'Conexão com MariaDB/MySQL realizada com sucesso!',
      resultado: results[0]
    });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando em http://0.0.0.0:${PORT}`);
});
