const sqlite3 = require('sqlite3').verbose();
const readline = require('readline');

const DB_PATH = './database.sqlite';

// --- Conexão com o Banco de Dados ---
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('\x1b[31m%s\x1b[0m', '❌ Erro ao conectar ao SQLite:', err.message);
        process.exit(1);
    }
});

// --- Funções Auxiliares ---
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));
const dbGet = (query, params = []) => new Promise((resolve, reject) => db.get(query, params, (err, row) => (err ? reject(err) : resolve(row))));
const dbAll = (query, params = []) => new Promise((resolve, reject) => db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const dbRun = (query, params = []) => new Promise((resolve, reject) => db.run(query, params, function(err) { (err ? reject(err) : resolve(this)) }));

// --- Funções de Gerenciamento ---

async function addUser() {
    console.log('\n--- ✍️ Adicionar Novo Usuário ---');
    const name = await askQuestion('Qual o nome do usuário? ');
    const number = await askQuestion('Qual o número de WhatsApp (ex: 5543912345678)? ');
    const typeChoice = await askQuestion('Qual o tipo? (1: Admin, 2: Camarista, 3: Vendedor) ');

    if (!name || !number || !typeChoice) throw new Error('Operação cancelada. Todos os campos são necessários.');
    if (!/^\d+$/.test(number)) throw new Error('Número inválido. Insira apenas os dígitos.');
    
    const typeMap = { '1': 'admin', '2': 'camarista', '3': 'vendedor' };
    const type = typeMap[typeChoice];
    if (!type) throw new Error('Tipo de usuário inválido. Escolha 1, 2 ou 3.');

    const wppId = `${number}@c.us`;
    const existingUser = await dbGet('SELECT * FROM users WHERE wppId = ?', [wppId]);
    if (existingUser) throw new Error(`Usuário com o número ${number} já existe.`);

    await dbRun('INSERT INTO users (wppId, name, type) VALUES (?, ?, ?)', [wppId, name, type]);
    console.log('\x1b[32m%s\x1b[0m', `✅ Usuário "${name}" (${type}) foi adicionado com sucesso!`);
}

async function editUser() {
    console.log('\n--- ✏️ Editar Usuário Existente ---');
    const users = await dbAll('SELECT * FROM users ORDER BY name');
    if (users.length === 0) {
        console.log('Nenhum usuário cadastrado para editar.');
        return;
    }

    console.log('Selecione o usuário que deseja editar:');
    users.forEach((user, index) => {
        console.log(` ${index + 1}. ${user.name} (${user.type}) - ${user.wppId}`);
    });
    const choice = await askQuestion('Digite o número do usuário: ');
    const userIndex = parseInt(choice) - 1;

    if (isNaN(userIndex) || !users[userIndex]) throw new Error('Seleção inválida.');
    
    const userToEdit = users[userIndex];
    console.log(`\nEditando: ${userToEdit.name}`);
    console.log('O que você deseja alterar? (1: Nome, 2: Tipo)');
    const fieldChoice = await askQuestion('Digite sua opção: ');

    if (fieldChoice === '1') {
        const newName = await askQuestion(`Digite o novo nome para "${userToEdit.name}": `);
        if (!newName) throw new Error('Nome não pode ser vazio.');
        await dbRun('UPDATE users SET name = ? WHERE wppId = ?', [newName, userToEdit.wppId]);
        console.log('\x1b[32m%s\x1b[0m', '✅ Nome atualizado com sucesso!');
    } else if (fieldChoice === '2') {
        const newTypeChoice = await askQuestion('Digite o novo tipo (1: Admin, 2: Camarista, 3: Vendedor): ');
        const typeMap = { '1': 'admin', '2': 'camarista', '3': 'vendedor' };
        const newType = typeMap[newTypeChoice];
        if (!newType) throw new Error('Tipo inválido.');
        await dbRun('UPDATE users SET type = ? WHERE wppId = ?', [newType, userToEdit.wppId]);
        console.log('\x1b[32m%s\x1b[0m', '✅ Tipo atualizado com sucesso!');
    } else {
        throw new Error('Opção inválida.');
    }
}

async function viewConfig() {
    console.log('\n--- ⚙️ Visualizar Configurações ---');
    const config = await dbAll('SELECT * FROM config ORDER BY key');
    config.forEach(c => {
        console.log(` ${c.key}: ${c.value}`);
    });
}

async function editConfig() {
    console.log('\n--- 🔧 Editar Configuração ---');
    const configs = await dbAll('SELECT * FROM config ORDER BY key');
    
    console.log('Selecione a configuração que deseja editar:');
    configs.forEach((c, index) => {
        console.log(` ${index + 1}. ${c.key}: ${c.value}`);
    });
    const choice = await askQuestion('Digite o número da configuração: ');
    const configIndex = parseInt(choice) - 1;

    if (isNaN(configIndex) || !configs[configIndex]) throw new Error('Seleção inválida.');

    const configToEdit = configs[configIndex];
    const newValue = await askQuestion(`Digite o novo valor para "${configToEdit.key}": `);
    if (!newValue) throw new Error('O valor não pode ser vazio.');

    await dbRun('UPDATE config SET value = ? WHERE key = ?', [newValue, configToEdit.key]);
    console.log('\x1b[32m%s\x1b[0m', '✅ Configuração atualizada com sucesso!');
}


// --- Lógica Principal do Script (Menu) ---
async function runManager() {
    while (true) {
        console.log(`\n=============================================`);
        console.log('  Painel de Gerenciamento do Banco de Dados');
        console.log(`=============================================`);
        console.log('Escolha uma opção:');
        console.log(' 1. Adicionar um novo usuário');
        console.log(' 2. Editar um usuário existente');
        console.log(' 3. Visualizar configurações do bot');
        console.log(' 4. Editar uma configuração');
        console.log(' 5. Sair');
        const choice = await askQuestion('Opção: ');

        try {
            switch (choice) {
                case '1': await addUser(); break;
                case '2': await editUser(); break;
                case '3': await viewConfig(); break;
                case '4': await editConfig(); break;
                case '5': return; // Sai do loop e encerra o script
                default: console.log('\x1b[33m%s\x1b[0m', 'Opção inválida, tente novamente.');
            }
        } catch (err) {
            console.error('\x1b[31m%s\x1b[0m', `\n❌ ${err.message}`);
        }
    }
}

runManager().finally(() => {
    rl.close();
    db.close();
    console.log('\nScript finalizado.');
});