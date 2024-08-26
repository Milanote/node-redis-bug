const fs = require('fs');
const {createServer} = require('http');
const redis = require('redis-v3');
const {createClient} = require('redis');
const {io: ioc} = require('socket.io-client');
const {Server} = require('socket.io');
const {createAdapter} = require("@socket.io/redis-adapter");
const {GenericContainer} = require('testcontainers');

const NODES_COUNT = 2;

function times(count, fn) {
    let i = 0;
    return () => {
        i++;
        console.log(i);
        if (i === count) {
            fn();
        } else if (i > count) {
            throw new Error(`too many calls: ${i} instead of ${count}`);
        }
    };
}

function sleep(duration) {
    return new Promise((resolve) => setTimeout(resolve, duration));
}

function setup(clientVersion, createAdapter, redisPort) {
    const servers = [];
    const serverSockets = [];
    const clientSockets = [];
    const redisCleanupFunctions = [];

    return new Promise(async (resolve) => {
        for (let i = 1; i <= NODES_COUNT; i++) {
            const [adapter, redisCleanup] = await createAdapter(clientVersion, redisPort);

            const httpServer = createServer();
            const io = new Server(httpServer, {
                adapter,
            });

            io.on('connection', async (socket) => {
                console.log('SOCKET CONNECTION: ', socket.id);
                serverSockets.push(socket);
                servers.push(io);
                redisCleanupFunctions.push(redisCleanup);
                if (servers.length === NODES_COUNT) {
                    await sleep(200);
                    resolve({
                        servers,
                        serverSockets,
                        clientSockets,
                        adapter,
                        cleanup: () => {
                            servers.forEach((server) => server.close());
                            clientSockets.forEach((socket) => socket.disconnect());
                            redisCleanupFunctions.forEach((fn) => fn());
                        },
                    });
                }
            });
            httpServer.listen(() => {
                const address = httpServer.address();
                const port = typeof address === 'object' && address !== null ? address.port : 0;
                const clientSocket = ioc(`http://localhost:${port}`);
                clientSockets.push(clientSocket);
            });
        }
    });
}

const createRedisAdapter = async (clientVersion, port) => {
    const pubConfig = {
        name: 'PUB',
        url: `redis://127.0.0.1:${port}`,
    };
    const pubClient = clientVersion === 4 ? createClient(pubConfig) : redis.createClient(pubConfig);
    pubClient.on('error', (error) => {
        console.log('PUB: Unable to connect to DB', error);
    });

    const subConfig = {
        name: 'SUB',
        url: `redis://127.0.0.1:${port}`,
    };
    const subClient = clientVersion === 4 ? createClient(subConfig) : redis.createClient(subConfig);
    subClient.on('connect', () => {
        console.log('SUB: Connecting');
    });
    subClient.on('ready', () => {
        console.log('SUB: Is ready');
    });
    subClient.on('error', async (error) => {
        console.log('SUB: Unable to connect to DB', error);
    });
    subClient.on('end', () => {
        console.log('SUB: Disconnected');
    });
    subClient.on('reconnecting', () => {
        console.log('SUB: Reconnecting');
    });

    if (clientVersion === 4) {
        // client v4 requires manual connect
        await Promise.all([pubClient.connect(), subClient.connect()]);
    }

    const adapter = createAdapter(pubClient, subClient);

    return [
        adapter,
        () => {
            if (clientVersion === 4) {
                pubClient.quit();
                subClient.quit();
            } else {
                pubClient.quit();
                subClient.quit();
            }
        },
    ];
};

function setIntervalLimited(callback, interval, x) {
    for (let i = 0; i < x; i++) {
        setTimeout(callback, i * interval);
    }
}

describe('redis-adapter', () => {
    let startedRedisContainer;
    let servers;
    let clientSockets;
    let cleanup;

    beforeAll(async () => {
        startedRedisContainer = await new GenericContainer('redis:6.2-alpine')
            .withExposedPorts({ container: 6379, host: 6379 })
            .start();
    }, 30000);

    afterAll(async () => {
        await startedRedisContainer.stop();
    });

    describe('redis client v3', () => {
        beforeEach(async () => {
            const testContext = await setup(3, createRedisAdapter, 6379);
            servers = testContext.servers;
            clientSockets = testContext.clientSockets;
            cleanup = testContext.cleanup;
        }, 30000);

        afterEach(() => cleanup());

        it('happy case - small payload', (done) => {
            console.log('STARTING TEST');
            const partialDone = times(600, done);

            clientSockets[1].on('hello', (msg) => {
                console.log('got it!');
                partialDone();
            });

            setIntervalLimited(
                () => {
                    servers[0].emit('hello', 'world');
                },
                100,
                600,
            );
        }, 60000);

        it('Socket closed unexpectedly - large (5mb) payload', (done) => {
            console.log('STARTING TEST');
            const partialDone = times(600, done);

            clientSockets[1].on('hello', (msg) => {
                console.log('got it!');
                partialDone();
            });

            const data = fs.readFileSync('/Users/rod/Milanote/milanote/src/server/common/redis/5MB-min.json', 'utf8');

            setIntervalLimited(
                () => {
                    servers[0].emit('hello', data);
                },
                100,
                600,
            );
        }, 65000);
    });

    describe('redis client v4', () => {
        beforeEach(async () => {
            const testContext = await setup(4, createRedisAdapter, 6379);
            servers = testContext.servers;
            clientSockets = testContext.clientSockets;
            cleanup = testContext.cleanup;
        });

        afterEach(() => cleanup());

        it('happy case - small payload', (done) => {
            console.log('STARTING TEST');
            const partialDone = times(600, done);

            clientSockets[1].on('hello', (msg) => {
                console.log('got it!');
                partialDone();
            });

            setIntervalLimited(
                () => {
                    servers[0].emit('hello', 'world');
                },
                100,
                600,
            );
        }, 60000);

        it('Socket closed unexpectedly - large (5mb) payload', (done) => {
            console.log('STARTING TEST');
            const partialDone = times(600, done);

            clientSockets[1].on('hello', (msg) => {
                console.log('got it!');
                partialDone();
            });

            const data = fs.readFileSync('/Users/rod/Milanote/milanote/src/server/common/redis/5MB-min.json', 'utf8');

            setIntervalLimited(
                () => {
                    servers[0].emit('hello', data);
                },
                100,
                600,
            );
        }, 65000);
    });
});
