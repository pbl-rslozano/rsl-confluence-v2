"use client";

import { useMemo, useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2, LockKeyhole, Server, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_GATEWAY_URL,
  checkGateway,
  connectPrivateApi,
  disconnectPrivateApi,
  isLoopbackGateway,
  type PrivateApiEnvironment,
  type PrivateApiProfile,
  type PrivateApiProvider,
} from "@/lib/private-api";

interface PrivateApiDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: PrivateApiProfile | null;
  onProfileChange: (profile: PrivateApiProfile | null) => void;
}

const PROVIDER_LABELS: Record<PrivateApiProvider, string> = {
  binance: "Binance",
  bybit: "Bybit",
  bitget: "Bitget",
};

function emptySecretState() {
  return { apiKey: "", apiSecret: "", passphrase: "" };
}

export function PrivateApiDialog({
  open,
  onOpenChange,
  profile,
  onProfileChange,
}: PrivateApiDialogProps) {
  const [provider, setProvider] = useState<PrivateApiProvider>("bybit");
  const [environment, setEnvironment] = useState<PrivateApiEnvironment>("testnet");
  const [label, setLabel] = useState("Personal read-only");
  const [gatewayUrl, setGatewayUrl] = useState(DEFAULT_GATEWAY_URL);
  const [gatewayToken, setGatewayToken] = useState("");
  const [secrets, setSecrets] = useState(emptySecretState);
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState<"idle" | "checking" | "online" | "offline">("idle");
  const [error, setError] = useState<string | null>(null);

  const gatewayValid = useMemo(() => isLoopbackGateway(gatewayUrl), [gatewayUrl]);
  const formValid =
    gatewayValid &&
    gatewayToken.trim().length > 0 &&
    secrets.apiKey.trim().length > 0 &&
    secrets.apiSecret.trim().length > 0 &&
    (provider !== "bitget" || secrets.passphrase.trim().length > 0);

  const handleProviderChange = (value: PrivateApiProvider) => {
    setProvider(value);
    setEnvironment(value === "bitget" ? "mainnet" : "testnet");
    setSecrets(emptySecretState());
    setError(null);
  };

  const handleGatewayCheck = async () => {
    setGatewayStatus("checking");
    setError(null);
    try {
      await checkGateway({ url: gatewayUrl, token: gatewayToken });
      setGatewayStatus("online");
    } catch (reason) {
      setGatewayStatus("offline");
      setError(reason instanceof Error ? reason.message : "Local gateway is unavailable.");
    }
  };

  const handleConnect = async () => {
    if (!formValid) return;
    setBusy(true);
    setError(null);
    try {
      const connected = await connectPrivateApi({ url: gatewayUrl, token: gatewayToken }, {
        provider,
        environment,
        label: label.trim() || `${PROVIDER_LABELS[provider]} profile`,
        apiKey: secrets.apiKey.trim(),
        apiSecret: secrets.apiSecret.trim(),
        passphrase: provider === "bitget" ? secrets.passphrase : undefined,
      });
      setSecrets(emptySecretState());
      onProfileChange(connected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Credential test failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!profile) return;
    setBusy(true);
    setError(null);
    try {
      await disconnectPrivateApi(profile);
      onProfileChange(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not disconnect the profile.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) {
        setSecrets(emptySecretState());
        setShowSecret(false);
        setError(null);
        setGatewayStatus("idle");
      }
      onOpenChange(nextOpen);
    }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto border-zinc-700 bg-zinc-900 text-zinc-100 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LockKeyhole className="h-5 w-5 text-emerald-400" />
            Private API setup
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            Credentials are sent only to a gateway running on this computer, held in memory, and never stored in the browser.
          </DialogDescription>
        </DialogHeader>


        {profile ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 font-semibold text-emerald-300">
                    <ShieldCheck className="h-4 w-4" /> Connected securely
                  </div>
                  <div className="mt-2 text-sm text-zinc-300">{profile.label}</div>
                  <div className="mt-1 font-mono text-xs text-zinc-500">
                    {PROVIDER_LABELS[profile.provider]} · {profile.environment} · {profile.maskedKey}
                  </div>
                </div>
                <span className="rounded border border-zinc-700 px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-400">
                  {profile.readOnly === true ? "Read only" : profile.readOnly === false ? "Trading enabled" : "Permission unknown"}
                </span>
              </div>
              {profile.permissions.length > 0 && (
                <div className="mt-3 text-xs text-zinc-400">Permissions: {profile.permissions.join(", ")}</div>
              )}
            </div>
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              This build tests account access only. It exposes no order-placement endpoint, even when the exchange key has trading permission.
            </div>
            {error && <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">{error}</div>}
            <DialogFooter>
              <Button variant="outline" className="border-rose-500/40 text-rose-300" disabled={busy} onClick={handleDisconnect}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Disconnect and clear
              </Button>
              <Button variant="outline" className="border-zinc-700" onClick={() => onOpenChange(false)}>Close</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="private-provider">Exchange</Label>
                <Select value={provider} onValueChange={(value) => handleProviderChange(value as PrivateApiProvider)}>
                  <SelectTrigger id="private-provider" aria-label="Private API exchange" className="border-zinc-700 bg-zinc-950">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-zinc-700 bg-zinc-900">
                    <SelectItem value="binance">Binance</SelectItem>
                    <SelectItem value="bybit">Bybit</SelectItem>
                    <SelectItem value="bitget">Bitget</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="private-environment">Environment</Label>
                <Select value={environment} onValueChange={(value) => setEnvironment(value as PrivateApiEnvironment)} disabled={provider === "bitget"}>
                  <SelectTrigger id="private-environment" aria-label="Private API environment" className="border-zinc-700 bg-zinc-950">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-zinc-700 bg-zinc-900">
                    <SelectItem value="testnet">Testnet</SelectItem>
                    <SelectItem value="mainnet">Mainnet</SelectItem>
                  </SelectContent>
                </Select>
                {provider === "bitget" && <p className="text-[11px] text-zinc-500">Connection testing uses the main Bitget API.</p>}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="private-label">Profile label</Label>
              <Input id="private-label" value={label} onChange={(event) => setLabel(event.target.value)} className="border-zinc-700 bg-zinc-950" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="gateway-url"><Server className="h-3.5 w-3.5" /> Local gateway</Label>
              <div className="flex gap-2">
                <Input
                  id="gateway-url"
                  value={gatewayUrl}
                  onChange={(event) => { setGatewayUrl(event.target.value); setGatewayStatus("idle"); }}
                  className="border-zinc-700 bg-zinc-950 font-mono text-xs"
                  spellCheck={false}
                />
                <Button type="button" variant="outline" className="shrink-0 border-zinc-700" onClick={handleGatewayCheck} disabled={!gatewayValid || !gatewayToken.trim() || gatewayStatus === "checking"}>
                  {gatewayStatus === "checking" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Check"}
                </Button>
              </div>
              <p className={`text-[11px] ${gatewayStatus === "online" ? "text-emerald-400" : gatewayStatus === "offline" ? "text-rose-400" : "text-zinc-500"}`}>
                {gatewayStatus === "online" ? "Gateway online" : gatewayStatus === "offline" ? "Gateway unavailable — start it with npm run gateway" : "Only localhost and 127.0.0.1 are accepted. Start with npm run gateway."}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="gateway-token">Gateway token</Label>
              <Input
                id="gateway-token"
                value={gatewayToken}
                onChange={(event) => { setGatewayToken(event.target.value); setGatewayStatus("idle"); }}
                className="border-zinc-700 bg-zinc-950 font-mono text-xs"
                placeholder="Paste the token printed by npm run gateway"
                spellCheck={false}
                autoComplete="off"
              />
              <p className="text-[11px] text-zinc-500">
                Printed in the gateway console at startup and regenerated on every restart. Without it the gateway
                rejects every request, so another process on this machine cannot enumerate your connected accounts.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="private-api-key"><KeyRound className="h-3.5 w-3.5" /> API key</Label>
              <Input
                id="private-api-key"
                type="password"
                value={secrets.apiKey}
                onChange={(event) => setSecrets((current) => ({ ...current, apiKey: event.target.value }))}
                autoComplete="off"
                spellCheck={false}
                className="border-zinc-700 bg-zinc-950 font-mono"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="private-api-secret">API secret</Label>
              <div className="relative">
                <Input
                  id="private-api-secret"
                  type={showSecret ? "text" : "password"}
                  value={secrets.apiSecret}
                  onChange={(event) => setSecrets((current) => ({ ...current, apiSecret: event.target.value }))}
                  autoComplete="new-password"
                  spellCheck={false}
                  className="border-zinc-700 bg-zinc-950 pr-10 font-mono"
                />
                <button type="button" aria-label={showSecret ? "Hide API secret" : "Show API secret"} onClick={() => setShowSecret((value) => !value)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
                  {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {provider === "bitget" && (
              <div className="space-y-2">
                <Label htmlFor="private-passphrase">API passphrase</Label>
                <Input
                  id="private-passphrase"
                  type={showSecret ? "text" : "password"}
                  value={secrets.passphrase}
                  onChange={(event) => setSecrets((current) => ({ ...current, passphrase: event.target.value }))}
                  autoComplete="new-password"
                  spellCheck={false}
                  className="border-zinc-700 bg-zinc-950 font-mono"
                />
              </div>
            )}

            <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
              <div className="font-semibold">Before connecting</div>
              <ul className="list-disc space-y-1 pl-4 text-amber-100/80">
                <li>Create a dedicated read-only key first.</li>
                <li>Disable withdrawals and add an IP allowlist at the exchange.</li>
                <li>Use testnet until execution and risk controls are independently verified.</li>
              </ul>
            </div>

            {error && <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">{error}</div>}

            <DialogFooter>
              <Button variant="outline" className="border-zinc-700" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button className="bg-emerald-600 text-white hover:bg-emerald-500" disabled={!formValid || busy} onClick={handleConnect}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Test and connect
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

