class WhatsAppProvider {
    constructor(name) {
        this.name = name;
    }

    initialize() { throw new Error(`${this.name} provider does not implement initialize()`); }
    async connect() { throw new Error(`${this.name} provider does not implement connect()`); }
    async disconnect() { throw new Error(`${this.name} provider does not implement disconnect()`); }
    getStatus() { return 'disconnected'; }
    async sendMessage() { throw new Error(`${this.name} provider does not implement sendMessage()`); }
    getQRCode() { return null; }
    async handleIncomingMessage() { return undefined; }
}

module.exports = WhatsAppProvider;