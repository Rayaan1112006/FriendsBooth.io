
require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const MAX_PARTICIPANTS = 6;

// Middleware
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

// Socket.IO

const io = new Server(server, {
    cors: {
        origin: CLIENT_ORIGIN,
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 10 * 1024 * 1024
});


// Temporary in-memory room storage
const rooms = new Map();

// Generate unique room codes
function generateRoomCode() {
    return "FRND" + Math.floor(1000 + Math.random() * 9000);
}

// Health check
app.get("/", (req, res) => {
    res.json({
        message: "FriendsBooth backend is running!",
        status: "online"
    });
});

// Create a room
app.post("/api/rooms", (req, res) => {
    const roomName =
        String(req.body.roomName || "FriendsBooth Session")
        .trim()
        .slice(0, 60);

    if (!roomName) {
        return res.status(400).json({
            error: "Room name cannot be empty."
        });
    }

    let code;

    do {
        code = generateRoomCode();
    } while (rooms.has(code));

    const hostToken = crypto.randomBytes(32).toString("hex");

    const room = {
    code,
    roomName,
    hostToken,
    hostSocketId: null,
    participants: new Map(),
    captureSession: null,
    createdAt: Date.now()
};

    rooms.set(code, room);

    res.status(201).json({
        success: true,
        roomCode: code,
        roomName,
        hostToken
    });
});

// Check whether a room exists
app.get("/api/rooms/:code", (req, res) => {
    const code = req.params.code.toUpperCase();
    const room = rooms.get(code);

    if (!room) {
        return res.status(404).json({
            success: false,
            error: "Room not found."
        });
    }

    res.json({
        success: true,
        roomCode: room.code,
        roomName: room.roomName,
        participantCount: room.participants.size,
        maxParticipants: MAX_PARTICIPANTS
    });
});

// Remove a participant

function removeParticipant(socket) {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    // Cancel an active capture if this participant was involved.
    const session = room.captureSession;

    if (session && session.participantIds.includes(socket.id)) {
        room.captureSession = null;

        io.to(code).emit("capture:cancelled", {
            sessionId: session.id,
            reason: `${socket.data.name || "A participant"} left the booth.`
        });

        console.log(`Capture cancelled in ${code}: participant left.`);
    }

    // Remove the participant.
    room.participants.delete(socket.id);

    if (room.hostSocketId === socket.id) {
        room.hostSocketId = null;
    }

    socket.leave(code);
    socket.data.roomCode = null;
    socket.data.isHost = false;

    // Notify everyone else.
    io.to(code).emit("room:participant-left", {
        participantId: socket.id
    });

    // Delete an empty room.
    if (room.participants.size === 0) {
        rooms.delete(code);
    }
}

// Real-time connections
io.on("connection", (socket) => {

    console.log("Connected:", socket.id);

    // Join a room
    socket.on("room:join", (data, callback) => {
        
        const reply = typeof callback === "function"
            ? callback
            : () => {};

        const code = String(data?.roomCode || "")
            .trim()
            .toUpperCase();

        const name = String(data?.name || "Guest")
            .trim()
            .slice(0, 30);

        const room = rooms.get(code);

        if (!room) {
            return reply({
                success: false,
                error: "Room does not exist."
            });
        }

        if (socket.data.roomCode === code) {
            return reply({
                success: true,
                message: "Already in this room."
            });
        }

        // Prevent participants from joining during an active capture.
if (room.captureSession) {
    return reply({
        success: false,
        error: "A photo capture is in progress. Please try again shortly."
    });
}

        if (socket.data.roomCode) {
            removeParticipant(socket);
        }

        const isHost = Boolean(data?.hostToken);

        if (isHost && data.hostToken !== room.hostToken) {
            return reply({
                success: false,
                error: "Invalid host credentials."
            });
        }

        if (isHost && room.hostSocketId) {
            return reply({
                success: false,
                error: "Host is already connected."
            });
        }

        if (room.participants.size >= MAX_PARTICIPANTS) {
            return reply({
                success: false,
                error: "This booth is full."
            });
        }

        const participant = {
            id: socket.id,
            name,
            isHost
        };

        room.participants.set(socket.id, participant);
        socket.data.roomCode = code;
        socket.data.name = name;
        socket.data.isHost = isHost;

        if (isHost) {
            room.hostSocketId = socket.id;
        }

        socket.join(code);

        const participants = Array.from(
            room.participants.values()
        );

        // Send existing room information to the joining user
        reply({
            success: true,
            roomCode: code,
            roomName: room.roomName,
            participants
        });

        // Notify everyone else
        socket.to(code).emit("room:participant-joined", participant);

        console.log(`${name} joined ${code}`);
    });


socket.on("capture:request", (data, callback) => {
    const reply = typeof callback === "function"
        ? callback
        : () => {};

    const code = socket.data.roomCode;
    const room = rooms.get(code);

    // Verify room membership
    if (!room) {
        return reply({
            success: false,
            error: "You are not in an active room."
        });
    }

    // Only the authenticated host can trigger capture
    if (
        !socket.data.isHost ||
        room.hostSocketId !== socket.id
    ) {
        return reply({
            success: false,
            error: "Only the host can start a capture."
        });
    }

    // Validate capture settings
    const shotCount = Number(data?.shotCount);
    const countdownSeconds = Number(data?.countdownSeconds);

    if (![1, 4, 6].includes(shotCount)) {
        return reply({
            success: false,
            error: "Invalid shot count."
        });
    }

    if (![0, 3, 5].includes(countdownSeconds)) {
        return reply({
            success: false,
            error: "Invalid countdown duration."
        });
    }


// Prevent overlapping capture sessions
if (room.captureSession) {
    return reply({
        success: false,
        error: "A capture is already in progress."
    });
}

// Keep the host first, followed by guests in join order
const orderedParticipants = Array.from(
    room.participants.values()
).sort((a, b) => {
    if (a.isHost) return -1;
    if (b.isHost) return 1;
    return 0;
});

// Create a fresh collection session
room.captureSession = {
    id: crypto.randomUUID(),
    shotCount,
    participantIds: orderedParticipants.map(person => person.id),
    submissions: new Map(),
    createdAt: Date.now()
};


    // Schedule a shared start time
    const startAt = Date.now() + 3000;

    io.to(code).emit("capture:begin", {
    sessionId: room.captureSession.id,
    shotCount,
    countdownSeconds,
    startAt,
    initiatedBy: socket.data.name
});

    reply({
        success: true,
        startAt
    });
});


socket.on("capture:submit", (data, callback) => {
    const reply = typeof callback === "function"
        ? callback
        : () => {};

    const code = socket.data.roomCode;
    const room = rooms.get(code);
    const session = room?.captureSession;

    if (!room || !session) {
        return reply({
            success: false,
            error: "No active capture session."
        });
    }

    if (data?.sessionId !== session.id) {
    return reply({
        success: false,
        error: "This capture session has expired."
    });
}

    // Only participants included when capture began can submit
    if (!session.participantIds.includes(socket.id)) {
        return reply({
            success: false,
            error: "You are not part of this capture."
        });
    }

    // Validate submitted frames
    if (
        !Array.isArray(data?.frames) ||
        data.frames.length !== session.shotCount ||
        !data.frames.every(frame =>
            typeof frame === "string" &&
            frame.startsWith("data:image/")
        )
    ) {
        return reply({
            success: false,
            error: "Invalid photo frames."
        });
    }

    // Prevent duplicate submissions
    if (session.submissions.has(socket.id)) {
        return reply({
            success: false,
            error: "You have already submitted your photos."
        });
    }

    session.submissions.set(socket.id, data.frames);

    reply({
        success: true,
        received: session.submissions.size
    });

    console.log(
        `${socket.data.name} submitted photos (${session.submissions.size}/${session.participantIds.length})`
    );

    // Wait until everyone has submitted
    if (session.submissions.size !== session.participantIds.length) {
        return;
    }

    // Preserve host-first, then join order
    const orderedParticipants = session.participantIds.map(id =>
    room.participants.get(id)
);

if (orderedParticipants.some(person => !person)) {
    room.captureSession = null;

    io.to(code).emit("capture:cancelled", {
        sessionId: session.id,
        reason: "A participant left during capture."
    });

    return;
}

    const sharedFrames = orderedParticipants.map(person => ({
        participantId: person.id,
        name: person.name,
        frames: session.submissions.get(person.id)
    }));

    // Send the same collected photos to everyone
    io.to(code).emit("capture:complete", {
        sessionId: session.id,
        participants: sharedFrames,
        shotCount: session.shotCount
    });

    room.captureSession = null;

    console.log(`Shared photo collection completed in ${code}`);
});



    // WebRTC signaling: forward offer, answer and ICE candidates
    
function forwardSignal(eventName, data) {
    const code = socket.data.roomCode;
    const targetId = data?.targetId;

    if (!code || typeof targetId !== "string") return;

    const target = io.sockets.sockets.get(targetId);

    if (!target || target.data.roomCode !== code) return;

    io.to(targetId).emit(eventName, {
        ...data,
        senderId: socket.id,
        senderName: socket.data.name
    });
}


    socket.on("webrtc:offer", (data) => {
        forwardSignal("webrtc:offer", data);
    });

    socket.on("webrtc:answer", (data) => {
        forwardSignal("webrtc:answer", data);
    });

    socket.on("webrtc:ice-candidate", (data) => {
        forwardSignal("webrtc:ice-candidate", data);
    });

    // Leave room
    socket.on("room:leave", () => {
        removeParticipant(socket);
    });

    // Disconnect
    socket.on("disconnect", () => {
        console.log("Disconnected:", socket.id);
        removeParticipant(socket);
    });
});

// Start server
server.listen(PORT, () => {
    console.log("--------------------------------");
    console.log(" FriendsBooth Backend");
    console.log("--------------------------------");
    console.log(` Server: http://localhost:${PORT}`);
    console.log(" Status: Running");
    console.log("--------------------------------");
});
