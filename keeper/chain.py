"""The thin layer between the keeper and the network.

Everything goes through the stellar CLI rather than raw RPC, for one reason:
the CLI decodes XDR into JSON using the contract's own spec, so a struct comes
back with its field names instead of a tuple this file would have to know the
shape of. Fewer places to be silently wrong when a contract changes.
"""

import json
import subprocess
import urllib.request

NETWORK = "testnet"
HORIZON = "https://horizon-testnet.stellar.org"


class Chain:
    def __init__(self, source, network=NETWORK):
        self.source = source
        self.network = network

    def _run(self, args, quiet=True):
        cmd = ["stellar", *args]
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode != 0:
            raise ChainError(p.stderr.strip() or p.stdout.strip(), args)
        return p.stdout.strip()

    def call(self, contract_id, fn, source=None, **kwargs):
        """Invoke, and give back the decoded return value."""
        args = [
            "contract", "invoke", "--quiet",
            "--id", contract_id,
            "--source", source or self.source,
            "--network", self.network,
            "--",
            fn,
        ]
        for k, v in kwargs.items():
            args += [f"--{k}", v if isinstance(v, str) else json.dumps(v)]
        out = self._run(args)
        if not out:
            return None
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            return out

    def ledger(self):
        with urllib.request.urlopen(f"{HORIZON}/ledgers?order=desc&limit=1", timeout=20) as r:
            return json.load(r)["_embedded"]["records"][0]["sequence"]

    def events(self, contract_id, back=5000):
        """Recent events for one contract, decoded.

        The window is deliberately short because that is all testnet keeps.
        Anything older is gone from the RPC, which is why the keeper writes
        what it finds to disk instead of rescanning history every run.
        """
        start = max(1, self.ledger() - back)
        args = [
            "events", "--start-ledger", str(start),
            "--id", contract_id, "--network", self.network, "--output", "json",
        ]
        out = self._run(args)
        if not out or out == "No events":
            return []
        found = []
        for line in out.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                found.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        return found


class ChainError(RuntimeError):
    def __init__(self, message, args_):
        super().__init__(message)
        self.cmd = args_

    def contract_error(self):
        """The contract error code, when that is what went wrong."""
        import re

        m = re.search(r"Error\(Contract, #(\d+)\)", str(self))
        return int(m.group(1)) if m else None
