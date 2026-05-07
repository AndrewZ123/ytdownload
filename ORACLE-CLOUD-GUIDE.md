# 🛠️ Oracle Cloud Setup — Complete Troubleshooting Guide

This guide covers the two most common issues when setting up your Oracle Cloud Free Tier instance for the YT Music Downloader:

1. **"Out of capacity"** when creating a VM
2. **VCN / networking problems**

---

## Problem 1: "Out of Capacity" Error

### Why It Happens
Oracle Cloud Free Tier ARM (Ampere A1) instances are extremely popular. Oracle has a limited pool of free ARM servers per availability domain, and they're often fully subscribed. This is not your fault — it's a supply issue.

### Fix 1: Switch to AMD (Fastest Fix ✅)

The AMD shape `VM.Standard.E2.1.Micro` is **almost never** out of capacity. It has less resources but works perfectly for this app.

1. In the instance creation wizard, click **Change Shape**
2. Switch to **VM.Standard.E2.1.Micro** (AMD x86)
3. Everything else stays the same → click **Create**

**Will it work?** Yes. Your app is a single Node.js server + Docker + yt-dlp. It runs fine on 1 vCPU and 1 GB RAM. The ARM instance would give you more headroom, but the AMD one is sufficient.

> You can always create an ARM instance later when capacity opens up, and migrate your data over. You can have both AMD and ARM on the free tier simultaneously.

### Fix 2: Try a Different Availability Domain (AD)

Oracle has up to 3 availability domains per region. One may have capacity while others don't.

1. At the top of the instance creation page, look for the **Availability Domain** dropdown
2. Switch between **AD-1**, **AD-2**, **AD-3** — try creating the instance after each switch
3. You only need to change the AD — everything else can stay the same

### Fix 3: Try at a Different Time

ARM capacity fluctuates throughout the day as people create and delete instances. Try:
- Early morning (your local time)
- Late at night
- Weekends

### Fix 4: Use the OCI CLI to Auto-Retry

If you're determined to get an ARM instance, you can use a script that retries every 60 seconds until capacity opens up. This can take anywhere from minutes to days.

**Setup the OCI CLI on your Mac:**
```bash
# Install
brew install oci-cli

# Configure (you'll need your Oracle Cloud credentials)
oci setup config
# When prompted:
#   Location: accept default
#   User OCID: find at Profile → User Settings → OCID
#   Tenancy OCID: found on same page
#   Region: your home region (e.g., eu-milan-1)
#   Generate new key pair: Y
#   Passphrase: leave empty
#   Upload the public key to your Oracle Cloud profile (it'll show you the path)
```

**Get the IDs you need from the Oracle Cloud Console:**
- **Compartment ID**: ☰ → Identity → Compartments → click your compartment → copy OCID
- **Subnet ID**: ☰ → Networking → Virtual Cloud Networks → click your VCN → click Public Subnet → copy OCID
- **Image ID**: ☰ → Compute → Images → filter for "Canonical Ubuntu 22.04" → copy OCID (pick the ARM one if going for ARM)
- **Availability Domain**: shown at top of instance creation page (e.g., `Uocm:EU-MILAN-1-AD-1`)

**Run the retry script:**
```bash
COMPARTMENT_ID="ocid1.compartment.oc1..YOUR_COMPARTMENT_ID"
SUBNET_ID="ocid1.subnet.oc1.YOUR_SUBNET_ID"
SSH_KEY="$(cat ~/.ssh/id_rsa.pub)"
IMAGE_ID="ocid1.image.oc1.YOUR_IMAGE_ID"
AVAILABILITY_DOMAIN="YOUR_AVAILABILITY_DOMAIN"

while true; do
  echo "$(date): Attempting to create ARM instance..."
  oci compute instance launch \
    --display-name "ytmusic-arm" \
    --compartment-id "$COMPARTMENT_ID" \
    --availability-domain "$AVAILABILITY_DOMAIN" \
    --shape "VM.Standard.A1.Flex" \
    --shape-config '{"ocpus": 1, "memoryInGBs": 6}' \
    --source-details "{\"sourceType\":\"image\",\"imageId\":\"$IMAGE_ID\",\"bootVolumeSizeInGBs\":50}" \
    --create-vnic-details "{\"subnetId\":\"$SUBNET_ID\",\"assignPublicIp\":true}" \
    --metadata "{\"ssh_authorized_keys\":\"$SSH_KEY\"}" \
    --wait-for-state "RUNNING" 2>&1
  
  if [ $? -eq 0 ]; then
    echo "✅ SUCCESS! Instance created!"
    break
  fi
  echo "❌ Failed, retrying in 60 seconds..."
  sleep 60
done
```

### Fix 5: Consider a Different Region

Some regions are much less saturated. If you haven't signed up yet, consider one of these:

| Region | Code | ARM Availability |
|--------|------|-----------------|
| Italy (Milan) | `eu-milan-1` | Usually good |
| UAE (Dubai) | `me-dubai-1` | Usually good |
| Japan (Tokyo) | `ap-tokyo-1` | Moderate |
| South Korea (Seoul) | `ap-seoul-1` | Moderate |
| Brazil (São Paulo) | `sa-saopaulo-1` | Moderate |
| US East (Ashburn) | `us-ashburn-1` | Very busy |
| Germany (Frankfurt) | `eu-frankfurt-1` | Very busy |

> ⚠️ **You cannot change your home region after signing up.** You'd need to create a new account.

---

## Problem 2: VCN / Networking Issues

### Fix A: Create the VCN Manually FIRST

The instance creation wizard tries to auto-create a VCN, but this often fails. Create it manually:

1. Go to **☰ → Networking → Virtual Cloud Networks**
2. Click **Start VCN Wizard**
3. Select **VCN with Internet Connectivity** → click Start
4. Fill in:
   - **VCN Name**: `ytmusic-vcn`
   - **Compartment**: your root compartment (pre-selected)
   - **VCN CIDR**: `10.0.0.0/16`
   - **Public Subnet CIDR**: `10.0.1.0/24`
   - **Private Subnet CIDR**: `10.0.2.0/24`
   - **DNS Resolution**: ✅ Check "Use DNS hostnames in this VCN"
5. Click **Next** → **Create**
6. Wait ~30 seconds → click **View VCN**

**Then open port 3000 immediately:**
1. On the VCN detail page → **Security Lists** (left sidebar)
2. Click **Default Security List for ytmusic-vcn**
3. **Add Ingress Rules**:
   - Source CIDR: `0.0.0.0/0`
   - Destination Port Range: `3000`
   - Protocol: TCP
4. Click **Add Ingress Rules**

**Now create your instance and point it to this VCN:**
1. ☰ → Compute → Instances → Create Instance
2. In the **Networking** section, click **Edit**
3. Select **"Select an existing VCN"**
4. Choose `ytmusic-vcn`
5. Subnet: pick the **Public** one
6. Ensure **"Assign a public IPv4 address"** is checked ✅

### Fix B: "Failed to create VCN" / VCN Wizard Errors

This usually means there's a stale VCN from a previous failed attempt:

1. Go to **☰ → Networking → Virtual Cloud Networks**
2. Delete any VCNs in a failed/deleting state
3. **Wait 5 minutes** for Oracle to fully clean up
4. Try the VCN wizard again with a **different name** (e.g., `ytmusic-vcn-2`)

### Fix C: "No Public IP" / "Subnet Not Available"

Check these things on your VCN:

1. **Internet Gateway exists**: VCN detail page → left sidebar → Internet Gateways → should have one
2. **Public Subnet**: the subnet must be Public (not Private)
3. **Route Table**: Public subnet's route table must have `0.0.0.0/0 → Internet Gateway`
4. **Security List rules**:

   | Source | Protocol | Port | Purpose |
   |--------|----------|------|---------|
   | `0.0.0.0/0` | TCP | `22` | SSH access |
   | `0.0.0.0/0` | TCP | `3000 | YT Music app |

   Verify SSH port 22 rule exists (it's added by default, but double-check).

### Fix D: Can't Reach App at `http://IP:3000`

You've created the instance, opened port 3000 in the Security List, but the app doesn't load. **The most likely cause is iptables.**

Oracle Cloud Ubuntu images come with restrictive **iptables** firewall rules that block traffic even if the cloud Security List allows it. Fix:

```bash
# SSH into your VM, then run:
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save
```

If `netfilter-persistent` is not installed:
```bash
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save
```

**Other things to check:**
1. Is the app running? → `sudo systemctl status ytmusic`
2. Check app logs → `sudo journalctl -u ytmusic -f`
3. Verify Security List has port 3000 open (Step 3 in DEPLOY.md)
4. Try `curl http://localhost:3000` from inside the VM — if it works locally but not from outside, it's definitely a firewall issue

### Fix E: Instance Created But No Public IP

1. Go to instance detail page → look for **Primary VNIC Information** section
2. If "Public IP Address" is empty:
   - Click **Edit** on the VNIC
   - Check **"Assign a public IPv4 address"**
   - Save
3. If that's not available: go to **☰ → Networking → Reserved Public IPs**
   - Delete any unused reserved IPs (you might have hit the limit of 2)
   - Then go back and try assigning again

---

## The Recommended Path (TL;DR)

If you just want it working as fast as possible:

1. **Sign up** at cloud.oracle.com/free
2. **Create VCN manually** (Networking → VCN → Start VCN Wizard → VCN with Internet Connectivity)
3. **Open port 3000** in the VCN's Security List
4. **Create instance** with **AMD shape** (`VM.Standard.E2.1.Micro`) — skip ARM to avoid capacity issues
5. **Select your pre-made VCN** in the networking section
6. **SSH in** and run the setup script
7. **Open port 3000 in iptables** on the VM (`sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT && sudo netfilter-persistent save`)
8. **Connect your iPhone app** to `http://YOUR_IP:3000`

Total time: ~15 minutes.