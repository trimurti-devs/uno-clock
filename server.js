// Add proper CORS allowEIO3 flag and better default origins for WebSocket connections.
const io = require('socket.io')(server, {
    cors: {
        origin: ['https://example.com', 'https://another-example.com'], // Better default origins
        methods: ['GET', 'POST'],
        allowEIO3: true // Proper CORS flag
    }
});