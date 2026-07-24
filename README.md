# SilverStripe Bunny Stream

Bunny Stream video integration for SilverStripe — upload, manage, and embed videos
straight from the CMS, with the video files hosted on [Bunny Stream](https://bunny.net/stream/)'s
CDN instead of your own server.

Developed and maintained by [Restruct](https://restruct.nl).

## Features

- **Direct-to-Bunny uploads** from the CMS — the browser uploads straight to Bunny
  via resumable [TUS](https://tus.io/) chunks, so large video files never pass
  through your web server.
- **Re-use existing videos** — attach a video that's already been uploaded instead
  of uploading it again.
- **`BunnyVideo` DataObject** — a lightweight local record holding the Bunny GUID
  plus metadata (title, status, duration, dimensions, size) synced from the API.
- **Video admin** — a `ModelAdmin` listing all videos with thumbnails and status.
- **Embed helpers** — ready-to-use player iframe HTML with per-video options
  (autoplay, mute, loop, controls, remember-position, start-time, enforce-full-watch).
- **Signed embeds & uploads** — optional token authentication for private libraries.
- **Fail-closed deletes** — deleting a `BunnyVideo` deletes the remote video too,
  and won't silently orphan it if the API call fails.

## Requirements

- PHP 8.2+
- SilverStripe `^5`
- `guzzlehttp/guzzle ^7.3`
- A [Bunny.net](https://bunny.net/) account with a **Stream** library

## Installation

Install with Composer:

```bash
composer require restruct/silverstripe-bunnystream
```

> Not on Packagist? Add the repository to your project `composer.json` first:
>
> ```json
> "repositories": [
>     { "type": "vcs", "url": "https://github.com/DennisHamaka/silverstripe-bunnystream" }
> ]
> ```

Then build the database and expose the client assets:

```bash
vendor/bin/sake dev/build flush=1
composer vendor-expose
```

## Configuration

Set the following environment variables (e.g. in your `.env`):

| Variable | Required | Description |
| --- | --- | --- |
| `BUNNY_STREAM_LIBRARY_ID` | **Yes** | Your Bunny Stream library ID. |
| `BUNNY_STREAM_API_KEY` | **Yes** | The library's API key (Bunny dashboard → Stream → your library → API). |
| `BUNNY_STREAM_CDN_HOSTNAME` | No | Custom pull-zone hostname for thumbnails (e.g. `vz-xxxx.b-cdn.net`). |
| `BUNNY_STREAM_TOKEN_AUTH_KEY` | No | Library "Token Authentication Key". When set **and** token auth is enabled on the library, embed URLs are signed and expire after a time window (default 4h). |

```dotenv
BUNNY_STREAM_LIBRARY_ID="12345"
BUNNY_STREAM_API_KEY="xxxxxxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

## Basic usage

Add a `has_one` relation to `BunnyVideo` on any `DataObject` or page, and edit it
with `BunnyUploadField`:

```php
use Restruct\BunnyStream\Forms\BunnyUploadField;
use Restruct\BunnyStream\Model\BunnyVideo;
use SilverStripe\Forms\FieldList;

class HomePage extends \Page
{
    private static $has_one = [
        'HeaderVideo' => BunnyVideo::class,
    ];

    // Publish the linked video together with the page
    private static $owns = [
        'HeaderVideo',
    ];

    public function getCMSFields(): FieldList
    {
        $fields = parent::getCMSFields();

        // The scaffolded dropdown isn't useful — replace it with the upload field
        $fields->removeByName('HeaderVideoID');
        $fields->addFieldToTab('Root.Main',
            BunnyUploadField::create('HeaderVideoID', 'Header video')
                ->setDescription('Upload a new video or pick an existing one.')
        );

        return $fields;
    }
}
```

In the CMS the field lets an editor **upload a new video** or **select an
already-uploaded one** from a dropdown. Once attached, a preview shows the
thumbnail with **Bewerken** (open the video in the video admin) and **Ontkoppelen**
(detach) actions.

### Embedding the video in a template

`BunnyVideo::getPlayerIframeHTML()` builds a responsive player iframe. It takes an
options array that templates can't construct, so expose it through a method on the
owning class:

```php
use SilverStripe\ORM\FieldType\DBHTMLText;

public function getHeaderVideoEmbed(): DBHTMLText
{
    $html  = DBHTMLText::create();
    $video = $this->HeaderVideo();

    if (!$video || !$video->VideoGuid) {
        return $html->setValue('');
    }

    return $html->setValue($video->getPlayerIframeHTML([
        'autoplay' => true,
        'muted'    => true,
        'loop'     => true,
        'controls' => false,
    ]));
}
```

```html
<%-- Template --%>
<% if $HeaderVideoEmbed %>$HeaderVideoEmbed<% end_if %>
```

## The `BunnyVideo` model

Useful methods on `Restruct\BunnyStream\Model\BunnyVideo`:

| Method | Returns |
| --- | --- |
| `getPlayerIframeHTML(array $options = [])` | Responsive `<iframe>` embed. Options: `autoplay`, `muted`, `loop`, `controls`. |
| `getPlayerURL()` | The (optionally signed) embed URL. |
| `getThumbnailUrl()` | The poster/thumbnail URL. |
| `isReady()` | `true` once Bunny has finished transcoding. |
| `getStatusLabel()` | Human-readable status. |
| `getDurationFormatted()` | e.g. `1:23`. |
| `refreshFromApi()` | Pull the latest metadata from Bunny. |
| `getUsages()` | All records that link to this video. |

Per-video player options are editable in the video admin: `rememberPosition`
(resume at last position), `t` (start offset, e.g. `90s`), and `enforceFullWatch`
(the viewer can't skip past the furthest point watched).

## Video admin

The module registers a **Video's** admin menu listing every `BunnyVideo` with
thumbnail and status. Open a record to edit its title/description, set player
options, upload a custom poster, and see which records use it.

## Notes & gotchas

- **Deletes are fail-closed** — deleting a `BunnyVideo` deletes the remote video
  too; if that API call fails the local delete is aborted (an override checkbox is
  offered on the edit form).
- **Private-library thumbnails 403** — if the pull zone blocks direct file access,
  Bunny thumbnails won't render. Make them public and set `BUNNY_STREAM_CDN_HOSTNAME`,
  or supply your own poster image.
- Set `BUNNY_STREAM_TOKEN_AUTH_KEY` (and enable Token Authentication on the library)
  to make embed URLs expire — otherwise anyone with the URL can play the video.

## License

MIT © [Restruct](https://restruct.nl) · <dev@restruct.nl>
