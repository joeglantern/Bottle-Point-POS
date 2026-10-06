# Scanners and printers

Bottle Point runs in the browser, so it uses scanners and printers the way the device already does. Nothing needs installing on the server.

## Barcode scanners

### What works

| Scanner | Works | Notes |
|---|---|---|
| USB scanner (plugs in like a keyboard) | Yes, recommended | Windows, Mac, Chromebook, Android with a USB OTG cable |
| Bluetooth scanner in keyboard (HID) mode | Yes | Pair it like a keyboard. Most cheap scanners ship in this mode. |
| The device's camera | Chrome on Android, Chrome or Safari on Mac | Not on iPhone or iPad, and not in Chrome on Windows. The camera button only appears where it works. |
| Typing the barcode | Everywhere | The Scan button opens a box to type it |

### Setting up a scanner

1. The scanner must send **Enter (carriage return) after each code**. Most do by default. If not, scan the "Add Enter suffix" barcode in its manual.
2. Turn off any prefix the scanner adds.
3. On the till, scan a product. The status under the search box shows **Scanner ready** and then the code and the product it added. A code that matches nothing shows in red.

How it works: a scanner types the code much faster than a person can. Bottle Point recognises that speed anywhere on the till, even while the cursor is in the search box, and adds the product. Scanning works as long as the till screen is open and no dialog is showing.

Supported barcodes: EAN-13, EAN-8, UPC-A, UPC-E and Code 128 (the receipt barcode). A product's barcode is set in Inventory, Edit.

## Receipt printers

Receipts are laid out for thermal roll paper: **80mm** (72mm printable) or **58mm** (48mm printable). Choose the width once in the receipt window; the till remembers it. Everything prints in solid black.

### Windows or Mac with a USB or network thermal printer (Epson TM-T20, Xprinter, and similar)

1. Install the printer's driver from the maker's site.
2. In the printer's settings, set the paper to the **roll** size (80mm or 58mm, often called "80 x Receipt" or "Roll paper 80 x 297mm").
3. In Chrome, press **Print receipt**. In the print window choose the thermal printer, **Margins: None**, **Scale: Default**, and untick **Headers and footers**. Chrome remembers these for next time.

**Printing without the print window (dedicated till PCs):** start Chrome with the `--kiosk-printing` flag. It then prints straight to the default printer. On Windows, edit the Chrome shortcut's target to end with `--kiosk-printing`, and make the thermal printer the default printer.

### Android tablets with a Bluetooth or USB thermal printer

Android browsers print through the Android print service, and most cheap thermal printers do not come with one. Use **RawBT** (free on the Play Store):

1. Install RawBT and pair the printer in it. Set the paper width to match.
2. In Chrome on the tablet, press **Print receipt**, then choose **RawBT** as the printer.

The printer maker's own print service app works too, if there is one.

### iPhone and iPad

Safari prints only to AirPrint printers. Use an AirPrint thermal printer (for example Epson TM-m30III or Star mC-Print3), or print from a Windows, Mac or Android till instead.

### Checking a printer

Make a test sale, press **Print receipt** and check that:

- nothing is cut off on the right (if it is, set the paper to 58mm in the receipt window, or fix the paper size in the driver)
- there is no wide blank margin (set Margins to None)
- the text is black and sharp (darken the print density in the driver settings if it is pale)

A cash drawer connected to the printer opens when the driver is set to "open drawer after printing". That is a driver setting, not a Bottle Point one.
