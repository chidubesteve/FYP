// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title   TrustFlowDT
 * @author  Chidube Steve Anike (25020251) — Staffordshire University
 * @notice  Proof-of-Concept smart contract for oracle-validated Digital Twin
 *          data anchoring on Ethereum Layer-2. Implements device registration,
 *          RBAC-based access control, batched data anchoring, and anomaly flagging.
 *
 * @dev     Architecture informed by:
 *          - EtherTwin (Putz et al., 2021): RBAC structure and on/off-chain split
 *          - Suhail et al. (2022): identified gaps in data-source validation (23%)
 *            and scalability strategies (15%) in blockchain-DT literature
 *
 *          Key design decisions:
 *          1. Raw telemetry is NEVER stored on-chain — only keccak256 batch hashes.
 *             This directly addresses the scalability gap identified by Suhail et al. (2022) and reduces on-chain transaction volume relative to per-reading writes.
 *          2. The oracle role is the exclusive write authority for data anchoring.
 *             No direct device-to-chain writes are permitted, enforcing the
 *             oracle validation layer as a mandatory trust boundary.
 *          3. Device public key hashes are registered on-chain, binding device
 *             identity to cryptographic keys. This extends EtherTwin (Putz et al., 2021)
 *             which defines identity without cryptographic key binding.
 *
 * @custom:limitation  TEE attestation is simulated via ECDSA in the off-chain
 *                     oracle layer. Real TEE integration (ARM TrustZone, Intel SGX)  is identified as future work beyond PoC scope.
 */
contract TrustFlowDT {

    
    // SECTION 1: ACCESS CONTROL (RBAC)
    // Hierarchical role model — higher-valued roles inherit lower permissions.
    // Extends the role/permission model from EtherTwin (Putz et al., 2021).
    /**
    Permission	Twin	Document	Sensor
       	C	R	U	D	C	R	U	D	C	R	U	D
Device	✗	✓	✗	✗	✗	✓	✗	✗	✗	✓	✓	✗
Owner	✓	✓	✓	✓	✓	✓	✓	✓	✓	✓	✓	✓
Manufacturer	✗	✓	✗	✗	✗	✗	
✗	✗
Maintainer	✗	✓	✗	✗	
✗	
✗
Distributor	✗	✓	✗	✗	
✗	✗	✗	✗	✗ */
    

    enum Role { NONE, OBSERVER, DEVICE_OWNER, ORACLE, ADMIN }

    mapping(address => Role) private _roles;
    address public immutable admin;

    event RoleAssigned(address indexed account, Role role);

    modifier onlyMinRole(Role required) {
        require(_roles[msg.sender] >= required, "TrustFlowDT: insufficient role");
        _;
    }

    modifier onlyOracle() {
        require(_roles[msg.sender] == Role.ORACLE, "TrustFlowDT: caller is not oracle");
        _;
    }

    modifier onlyAdmin() {
        require(_roles[msg.sender] == Role.ADMIN, "TrustFlowDT: caller is not admin");
        _;
    }

    function getRole(address account) external view returns (Role) {
        return _roles[account];
    }

    function assignRole(address account, Role role) external onlyAdmin {
        _roles[account] = role;
        emit RoleAssigned(account, role);
    }

    
    // SECTION 2: DEVICE REGISTRY
    // Registers trusted IoT devices and binds their identity to a public key hash.
    // The publicKeyHash is keccak256(devicePublicKey) — computed off-chain.
    // On-chain storage of the hash (not the key) preserves privacy while enabling
    // the oracle to verify that signed payloads originate from registered devices.
    

    struct Device {
        bytes32 publicKeyHash;  // keccak256 of device ECDSA public key
        bool    isActive;
        bool    isFlagged;      // set true by oracle on anomaly detection
        uint256 registeredAt;
        string  deviceType;     // e.g. "temperature_sensor", "vibration_sensor"
    }

    // deviceId => Device. deviceId is keccak256(deviceSerialNumber) — computed off-chain.
    mapping(bytes32 => Device) private _devices;
    bytes32[] private _deviceIds;

    event DeviceRegistered(bytes32 indexed deviceId, string deviceType, uint256 timestamp);
    event DeviceFlagged(bytes32 indexed deviceId, string reason, uint256 timestamp);
    event DeviceUnflagged(bytes32 indexed deviceId, uint256 timestamp);

    /**
     * @notice Register a new IoT device with its cryptographic public key hash.
     * @param deviceId       keccak256 hash of the device serial number (off-chain).
     * @param publicKeyHash  keccak256 hash of the device ECDSA public key (off-chain).
     * @param deviceType     Human-readable sensor category string.
     */
    function registerDevice(
        bytes32 deviceId,
        bytes32 publicKeyHash,
        string calldata deviceType
    ) external onlyMinRole(Role.DEVICE_OWNER) {
        require(!_devices[deviceId].isActive, "TrustFlowDT: device already registered");
        require(publicKeyHash != bytes32(0), "TrustFlowDT: invalid public key hash");

        _devices[deviceId] = Device({
            publicKeyHash: publicKeyHash,
            isActive:      true,
            isFlagged:     false,
            registeredAt:  block.timestamp,
            deviceType:    deviceType
        });

        _deviceIds.push(deviceId);
        emit DeviceRegistered(deviceId, deviceType, block.timestamp);
    }

    function getDevice(bytes32 deviceId) external view returns (Device memory) {
        return _devices[deviceId];
    }

    function getDeviceCount() external view returns (uint256) {
        return _deviceIds.length;
    }

    
    // SECTION 3: DATA INTEGRITY ANCHORING
    // The oracle aggregates N validated readings into a single batch, computes
    // a keccak256 hash of the batch, and writes only that hash on-chain.
    // Raw telemetry remains off-chain (IPFS CID stored for retrieval if required).
    //
    // This batching mechanism is the primary scalability contribution: N readings
    // yield 1 transaction rather than N transactions, directly addressing the
    // scalability gap documented by Suhail et al. (2022).
    

    struct DataAnchor {
        bytes32 batchHash;       // keccak256 of JSON-encoded validated batch
        bytes32 deviceId;
        uint256 timestamp;
        uint256 readingCount;    // cardinality of readings in this batch
        string  ipfsCid;         // optional: CID pointing to off-chain batch payload
    }

    // Sequential anchor registry — anchorId => DataAnchor
    uint256 public anchorCount;
    mapping(uint256 => DataAnchor) private _anchors;

    // deviceId => array of anchorIds, for per-device audit trail
    mapping(bytes32 => uint256[]) private _deviceAnchors;

    event DataAnchored(
        uint256 indexed anchorId,
        bytes32 indexed deviceId,
        bytes32         batchHash,
        uint256         readingCount,
        uint256         timestamp
    );

    /**
     * @notice  Anchor a validated batch of sensor readings on-chain.
     *          Callable exclusively by the oracle role.
     * @param   deviceId      Registered device identifier.
     * @param   batchHash     keccak256 of the validated telemetry batch payload.
     * @param   readingCount  Number of individual readings aggregated in this batch.
     * @param   ipfsCid       IPFS content identifier for the raw off-chain payload (may be empty).
     * @return  anchorId      Sequential identifier for this anchor record.
     */
    function anchorData(
        bytes32 deviceId,
        bytes32 batchHash,
        uint256 readingCount,
        string  calldata ipfsCid
    ) external onlyOracle returns (uint256 anchorId) {
        require(_devices[deviceId].isActive,  "TrustFlowDT: device not registered");
        require(!_devices[deviceId].isFlagged, "TrustFlowDT: device is flagged. anchor rejected");
        require(batchHash   != bytes32(0), "TrustFlowDT: invalid batch hash");
        require(readingCount > 0,  "TrustFlowDT: reading count must be > 0");

        anchorId = anchorCount++;

        _anchors[anchorId] = DataAnchor({
            batchHash:    batchHash,
            deviceId:     deviceId,
            timestamp:    block.timestamp,
            readingCount: readingCount,
            ipfsCid:      ipfsCid
        });

        _deviceAnchors[deviceId].push(anchorId);

        emit DataAnchored(anchorId, deviceId, batchHash, readingCount, block.timestamp);
    }

    function getAnchor(uint256 anchorId) external view returns (DataAnchor memory) {
        require(anchorId < anchorCount, "TrustFlowDT: anchor does not exist");
        return _anchors[anchorId];
    }

    function getDeviceAnchors(bytes32 deviceId) external view returns (uint256[] memory) {
        return _deviceAnchors[deviceId];
    }

    
    // SECTION 4: CRYPTOGRAPHIC VERIFICATION
    // Allows any caller to verify that a given batchHash corresponds to an
    // existing, oracle-validated anchor record. Supports the 100% verifiability
    // criterion without exposing raw telemetry.
    

    /**
     * @notice  Verify that a batchHash is recorded in a specific anchor.
     * @param   anchorId   The anchor record to check against.
     * @param   batchHash  The hash to verify.
     * @return  True if the anchor exists and the hash matches.
     */
    function verifyBatchHash(
        uint256 anchorId,
        bytes32 batchHash
    ) external view returns (bool) {
        if (anchorId >= anchorCount) return false;
        return _anchors[anchorId].batchHash == batchHash;
    }

    // SECTION 5: ANOMALY FLAGGING
    // The oracle flags a device on-chain when it detects persistent anomalies
    // that cannot be attributed to sensor noise. Flagged devices are barred
    // from further data anchoring until an admin reviews and unflags them.
    // This creates an on-chain audit trail of compromise events.

    /**
     * @notice  Flag a device as potentially compromised. Oracle-only.
     * @param   deviceId  The device to flag.
     * @param   reason    Human-readable anomaly description for audit trail.
     */
    function flagDevice(
        bytes32 deviceId,
        string calldata reason
    ) external onlyOracle {
        require(_devices[deviceId].isActive, "TrustFlowDT: device not found");
        require(!_devices[deviceId].isFlagged, "TrustFlowDT: device already flagged");

        _devices[deviceId].isFlagged = true;
        emit DeviceFlagged(deviceId, reason, block.timestamp);
    }

    function unflagDevice(bytes32 deviceId) external onlyAdmin {
        require(_devices[deviceId].isActive,   "TrustFlowDT: device not found");
        require(_devices[deviceId].isFlagged,  "TrustFlowDT: device is not flagged");

        _devices[deviceId].isFlagged = false;
        emit DeviceUnflagged(deviceId, block.timestamp);
    }

    // CONSTRUCTOR

    constructor() {
        admin = msg.sender;
        _roles[msg.sender] = Role.ADMIN;
        emit RoleAssigned(msg.sender, Role.ADMIN);
    }
}
