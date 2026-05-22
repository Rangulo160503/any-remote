export function formatPairSummary(localType, remoteType, protocol) {
    const proto = (protocol || "udp").toLowerCase();
    if (localType === "relay" || remoteType === "relay") return `relay/${proto}`;
    if (localType === "srflx" || remoteType === "srflx") return "srflx";
    if (localType === "host" || remoteType === "host") return "host";
    return `${localType}/${remoteType}`;
}

export function logLocalCandidate(candidate) {
    const c = candidate.candidate || "";
    const typ = c.includes("typ relay")
        ? "relay"
        : c.includes("typ srflx")
          ? "srflx"
          : c.includes("typ host")
            ? "host"
            : candidate.type || "?";
    console.log("[any-remote] local_candidate", typ, candidate.protocol || "");
}
