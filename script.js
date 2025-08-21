document.addEventListener('DOMContentLoaded', () => {
    // Configuration
    const SIGNALING_SERVER_URL = `ws://${window.location.hostname}:3001`;
    const CHUNK_SIZE = 64 * 1024; // 64KB chunks for sending files

    // DOM Elements
    const selfDeviceElement = document.getElementById('self-device');
    const selfNameElement = document.getElementById('self-name');
    const peerListElement = document.getElementById('peer-list');
    const fileInputElement = document.getElementById('file-input');
    const incomingPrompt = document.getElementById('incoming-prompt');
    const progressModal = document.getElementById('progress-modal');
    
    // State
    let localId = null;
    let peers = new Map(); // Stores RTCPeerConnection objects
    let incomingFileData = {};
    let ws = new WebSocket(SIGNALING_SERVER_URL);
    
    // --- WebSocket Signaling ---
    ws.onmessage = (message) => {
        const data = JSON.parse(message.data);
        switch(data.type) {
            case 'welcome':
                localId = data.id;
                selfNameElement.textContent = data.deviceName;
                selfDeviceElement.style.display = 'flex';
                break;
            case 'updatePeers':
                updatePeerList(data.peers);
                break;
            case 'offer':
                handleOffer(data.offer, data.senderId, data.files);
                break;
            case 'answer':
                handleAnswer(data.answer, data.senderId);
                break;
            case 'candidate':
                handleCandidate(data.candidate, data.senderId);
                break;
        }
    };
    ws.onopen = () => console.log('Connected to signaling server');
    ws.onerror = (err) => console.error('WebSocket error:', err);

    function sendMessage(type, payload, targetId) {
        ws.send(JSON.stringify({ type, targetId, ...payload }));
    }

    // --- UI Management ---
    function updatePeerList(peerData) {
        peerListElement.innerHTML = '';
        peerData.forEach(peer => {
            if (peer.id === localId) return; // Don't show self in peer list
            const peerElement = document.createElement('div');
            peerElement.className = 'device-icon peer';
            peerElement.innerHTML = `
                <div class="icon-bg"></div>
                <span class="device-name">${peer.deviceName}</span>
            `;
            peerElement.onclick = () => {
                fileInputElement.dataset.targetId = peer.id;
                fileInputElement.dataset.targetName = peer.deviceName;
                fileInputElement.click();
            };
            peerListElement.appendChild(peerElement);
        });
    }

    fileInputElement.addEventListener('change', async (e) => {
        const files = e.target.files;
        const targetId = e.target.dataset.targetId;
        const targetName = e.target.dataset.targetName;
        if (!files.length || !targetId) return;

        const peerConnection = createPeerConnection(targetId);
        const dataChannel = peerConnection.createDataChannel('file-transfer');
        setupDataChannel(dataChannel, files, targetName);

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        const filesMetadata = Array.from(files).map(f => ({ name: f.name, size: f.size, type: f.type }));
        sendMessage('offer', { offer, files: filesMetadata }, targetId);
    });

    // --- WebRTC Logic ---
    function createPeerConnection(targetId) {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                sendMessage('candidate', { candidate: event.candidate }, targetId);
            }
        };
        pc.ondatachannel = (event) => {
            const receiveChannel = event.channel;
            receiveChannel.onmessage = handleReceiveMessage;
            receiveChannel.onopen = () => console.log('Receive channel open!');
            receiveChannel.onclose = () => console.log('Receive channel closed!');
        };
        peers.set(targetId, pc);
        return pc;
    }

    async function handleOffer(offer, senderId, files) {
        const pc = createPeerConnection(senderId);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        document.getElementById('sender-name').textContent = `Peer ${senderId.substr(0,4)}`; // Placeholder name
        document.getElementById('file-info').textContent = `wants to send you ${files.length} file(s) (${formatBytes(totalSize)})`;
        incomingPrompt.classList.remove('hidden');

        document.getElementById('accept-btn').onclick = async () => {
            incomingPrompt.classList.add('hidden');
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendMessage('answer', { answer }, senderId);
            incomingFileData[senderId] = { files, receivedSize: 0, receivedBuffers: [], currentFileIndex: 0 };
        };
        document.getElementById('decline-btn').onclick = () => incomingPrompt.classList.add('hidden');
    }

    async function handleAnswer(answer, senderId) {
        const pc = peers.get(senderId);
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }

    async function handleCandidate(candidate, senderId) {
        const pc = peers.get(senderId);
        if (pc && pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    }

    // --- Data Channel File Transfer ---
    function setupDataChannel(channel, files, targetName) {
        channel.binaryType = 'arraybuffer';
        channel.onopen = () => {
            console.log('Send channel open!');
            showProgressModal(files, targetName);
            sendFile(channel, files);
        };
        channel.onclose = () => console.log('Send channel closed!');
    }

    function sendFile(channel, files) {
        let fileIndex = 0;
        let currentFile = files[fileIndex];
        let offset = 0;
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);

        // Send metadata first
        channel.send(JSON.stringify({ type: 'start', files: Array.from(files).map(f => ({name: f.name, size: f.size})) }));
        
        const reader = new FileReader();
        reader.onload = (e) => {
            channel.send(e.target.result);
            offset += e.target.result.byteLength;
            updateProgress(offset, totalSize);
            
            if (offset < currentFile.size) {
                readSlice(offset);
            } else { // Current file done, move to next
                fileIndex++;
                if (fileIndex < files.length) {
                    currentFile = files[fileIndex];
                    offset = 0;
                    readSlice(offset);
                } else {
                     // All files sent
                     document.getElementById('transfer-status').textContent = 'Complete!';
                     document.getElementById('cancel-btn').textContent = 'Done';
                }
            }
        };

        const readSlice = (o) => {
            const slice = currentFile.slice(o, o + CHUNK_SIZE);
            reader.readAsArrayBuffer(slice);
        };
        readSlice(0);
    }
    
    function handleReceiveMessage(event) {
        const data = event.data;
        // Logic to handle incoming file chunks and reassemble them
        // This is complex and involves buffer management. For simplicity, we just save the chunk.
        
        // Naive implementation: save each chunk as a file. A real app would reassemble.
        const blob = new Blob([data]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chunk-${Date.now()}`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove();
        console.log(`Received and downloaded a chunk of size ${data.byteLength}`);
    }
    
    function showProgressModal(files, targetName) {
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        document.getElementById('progress-recipient-name').textContent = `Sending to ${targetName}`;
        document.getElementById('transfer-status').textContent = 'Sending...';
        progressModal.classList.remove('hidden');
        updateProgress(0, totalSize);
    }

    function updateProgress(sent, total) {
        const percentage = total > 0 ? Math.round((sent / total) * 100) : 100;
        document.getElementById('progress-bar').style.width = `${percentage}%`;
        document.getElementById('progress-text').textContent = `${percentage}%`;
    }
    
    document.getElementById('cancel-btn').onclick = () => {
        // Add logic to close peer connection if needed
        progressModal.classList.add('hidden');
    }

    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }
});
                         
