import { Injectable, NotFoundException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import Stripe from 'stripe';

@Injectable()
export class PaymentsService {
  private stripe: Stripe | null = null;

  constructor(private prisma: PrismaService, private config: ConfigService) {
    // Stripe é opcional no Render free: sem STRIPE_SECRET_KEY a app arranca
    // na mesma (cash funciona) e só o pagamento com cartão fica indisponível.
    const key = config.get<string>('STRIPE_SECRET_KEY', '');
    if (key) {
      this.stripe = new Stripe(key, { apiVersion: '2026-06-24.dahlia' });
    } else {
      console.warn('STRIPE_SECRET_KEY em falta — pagamentos com cartão desativados.');
    }
  }

  private cards() {
    if (!this.stripe) {
      throw new ServiceUnavailableException('Pagamentos com cartão indisponíveis de momento.');
    }
    return this.stripe;
  }

  async createPaymentIntent(tripId: string, userId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');
    if (trip.passengerId !== userId) throw new BadRequestException('Not your trip');
    if (trip.paymentMethod !== 'CARD') throw new BadRequestException('Trip uses cash payment');

    const amountCents = Math.round((trip.finalFare ?? trip.fareEstimate) * 100);

    const intent = await this.cards().paymentIntents.create({
      amount: amountCents,
      currency: 'sar',
      metadata: { tripId },
    });

    await this.prisma.payment.upsert({
      where: { tripId },
      create: {
        tripId,
        amount: trip.finalFare ?? trip.fareEstimate,
        currency: 'SAR',
        method: 'CARD',
        stripePaymentId: intent.id,
        stripeClientSecret: intent.client_secret,
      },
      update: {
        stripePaymentId: intent.id,
        stripeClientSecret: intent.client_secret,
      },
    });

    return { clientSecret: intent.client_secret };
  }

  async confirmPayment(tripId: string, userId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');
    if (trip.passengerId !== userId) throw new BadRequestException('Not your trip');

    const payment = await this.prisma.payment.findUnique({ where: { tripId } });
    if (!payment) throw new NotFoundException('Payment not found');

    // Never trust the client's word that it paid — check with Stripe.
    if (payment.stripePaymentId) {
      const intent = await this.cards().paymentIntents.retrieve(payment.stripePaymentId);
      if (intent.status !== 'succeeded') {
        throw new BadRequestException(`Payment not completed (status: ${intent.status})`);
      }
    }

    await this.prisma.payment.update({
      where: { tripId },
      data: { status: 'PAID' },
    });

    await this.prisma.trip.update({
      where: { id: tripId },
      data: { paymentStatus: 'PAID' },
    });

    return { success: true };
  }
}
